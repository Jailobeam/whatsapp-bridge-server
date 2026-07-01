'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const {
    default: makeWASocket,
    Browsers,
    DisconnectReason,
    USyncQuery,
    USyncUser,
    useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT || '3008', 10),
    host: process.env.HOST || '0.0.0.0',
    sessionDir: process.env.SESSION_DIR || path.join(__dirname, 'session'),
    runtimeConfigPath: process.env.RUNTIME_CONFIG_PATH || path.join(__dirname, 'bridge-config.json'),
    logLevel: process.env.LOG_LEVEL || 'silent',
};

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

fs.mkdirSync(config.sessionDir, { recursive: true });
fs.mkdirSync(path.dirname(config.runtimeConfigPath), { recursive: true });

function loadRuntimeConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(config.runtimeConfigPath, 'utf8'));
        return {
            apiToken: typeof parsed.apiToken === 'string'
                ? parsed.apiToken
                : typeof parsed.adapterToken === 'string'
                    ? parsed.adapterToken
                    : '',
            pairingCode: typeof parsed.pairingCode === 'object' && parsed.pairingCode !== null
                ? {
                    code: typeof parsed.pairingCode.code === 'string' ? parsed.pairingCode.code : '',
                    expiresAt: typeof parsed.pairingCode.expiresAt === 'string' ? parsed.pairingCode.expiresAt : '',
                }
                : {
                    code: '',
                    expiresAt: '',
                },
            chatMappings: typeof parsed.chatMappings === 'object' && parsed.chatMappings !== null ? parsed.chatMappings : {},
        };
    } catch {
        return {
            apiToken: '',
            pairingCode: {
                code: '',
                expiresAt: '',
            },
            chatMappings: {},
        };
    }
}

const runtimeConfig = loadRuntimeConfig();

function saveRuntimeConfig() {
    fs.writeFileSync(config.runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8');
}

function getApiToken() {
    return String(runtimeConfig.apiToken || '').trim();
}

function clearPairingCode() {
    runtimeConfig.pairingCode = {
        code: '',
        expiresAt: '',
    };
    saveRuntimeConfig();
}

function clearApiToken() {
    runtimeConfig.apiToken = '';
    runtimeConfig.pairingCode = {
        code: '',
        expiresAt: '',
    };
    saveRuntimeConfig();
}

function generateApiToken() {
    runtimeConfig.apiToken = crypto.randomBytes(24).toString('hex');
    runtimeConfig.pairingCode = {
        code: '',
        expiresAt: '',
    };
    saveRuntimeConfig();
    return runtimeConfig.apiToken;
}

function getActivePairingCode() {
    const code = String(runtimeConfig.pairingCode?.code || '').trim();
    const expiresAt = String(runtimeConfig.pairingCode?.expiresAt || '').trim();
    if (!code || !expiresAt) {
        return null;
    }

    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        clearPairingCode();
        return null;
    }

    return {
        code,
        expiresAt,
    };
}

function generatePairingCode() {
    const rawCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}`;
    runtimeConfig.pairingCode = {
        code,
        expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString(),
    };
    saveRuntimeConfig();
    return getActivePairingCode();
}

function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!/^\d{6,20}$/.test(digits)) {
        return '';
    }
    return digits;
}

function toPhoneKey(phone) {
    return normalizePhone(phone);
}

function rememberChatMapping(phone, chatId) {
    const phoneKey = toPhoneKey(phone);
    const normalizedChatId = String(chatId || '').trim();
    if (!phoneKey || !normalizedChatId) {
        return false;
    }

    if (runtimeConfig.chatMappings[phoneKey] === normalizedChatId) {
        return false;
    }

    runtimeConfig.chatMappings[phoneKey] = normalizedChatId;
    saveRuntimeConfig();
    return true;
}

function hasKnownChat(phone, jid) {
    const phoneKey = toPhoneKey(phone);
    const jidValue = String(jid || '').trim();
    if (!phoneKey) {
        return false;
    }

    const mapped = String(runtimeConfig.chatMappings[phoneKey] || '').trim();
    return Boolean(mapped && (!jidValue || mapped === jidValue || mapped === `${phoneKey}@s.whatsapp.net`));
}

function normalizeAccount(value) {
    const raw = String(value || '');
    const withoutServer = raw.includes('@') ? raw.split('@')[0] : raw;
    const withoutDevice = withoutServer.includes(':') ? withoutServer.split(':')[0] : withoutServer;
    return normalizePhone(withoutDevice);
}

function getDisconnectStatusCode(lastDisconnect) {
    return lastDisconnect?.error?.output?.statusCode
        || lastDisconnect?.error?.data?.statusCode
        || lastDisconnect?.error?.statusCode
        || 0;
}

function extractMessageBody(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }

    return String(
        message.conversation
        || message.extendedTextMessage?.text
        || message.imageMessage?.caption
        || message.videoMessage?.caption
        || message.documentMessage?.caption
        || ''
    ).trim();
}

const state = {
    status: 'starting',
    qrText: '',
    qrSvg: '',
    lastError: '',
    lastReadyAt: '',
    lastEventAt: new Date().toISOString(),
    account: '',
    lastSendAt: '',
    lastSendId: '',
    lastSendTo: '',
    lastSendResolvedTo: '',
    lastSendAck: '',
    lastSendError: '',
    lastIncomingAt: '',
    lastIncomingFrom: '',
    lastIncomingChatId: '',
    lastIncomingBody: '',
    lastSendLookup: '',
    reachoutTimelockActive: false,
    reachoutTimelockUntil: '',
    reachoutTimelockType: '',
};

let socket = null;
let initializePromise = null;
let resetPromise = null;
let reconnectTimer = null;
let socketGeneration = 0;
let logoutNonce = crypto.randomBytes(16).toString('hex');
let isShuttingDown = false;
let suppressReconnect = false;
let signalUtilsPromise = null;

function updateState(patch) {
    Object.assign(state, patch, {
        lastEventAt: new Date().toISOString(),
    });
}

function setLastError(error) {
    updateState({
        lastError: error instanceof Error ? error.message : String(error || ''),
    });
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

async function getSignalUtils() {
    if (!signalUtilsPromise) {
        signalUtilsPromise = import('@whiskeysockets/baileys/lib/Utils/signal.js');
    }

    return signalUtilsPromise;
}

async function refreshQrSvg(qrText) {
    if (!qrText) {
        updateState({
            qrText: '',
            qrSvg: '',
        });
        return;
    }

    qrcodeTerminal.generate(qrText, { small: true });
    const qrSvg = await QRCode.toString(qrText, {
        type: 'svg',
        margin: 1,
        width: 320,
    });

    updateState({
        qrText,
        qrSvg,
    });
}

function buildStatusPayload() {
    const pairingCode = getActivePairingCode();
    return {
        status: state.status,
        account: state.account,
        lastReadyAt: state.lastReadyAt,
        lastEventAt: state.lastEventAt,
        lastError: state.lastError,
        hasQr: Boolean(state.qrSvg),
        authEnabled: Boolean(getApiToken()),
        tokenConfigured: Boolean(getApiToken()),
        pairingCodeAvailable: Boolean(pairingCode?.code),
        pairingCodeExpiresAt: pairingCode?.expiresAt || '',
        lastSendAt: state.lastSendAt,
        lastSendId: state.lastSendId,
        lastSendTo: state.lastSendTo,
        lastSendResolvedTo: state.lastSendResolvedTo,
        lastSendAck: state.lastSendAck,
        lastSendError: state.lastSendError,
        lastSendLookup: state.lastSendLookup,
        lastIncomingAt: state.lastIncomingAt,
        lastIncomingFrom: state.lastIncomingFrom,
        lastIncomingChatId: state.lastIncomingChatId,
        lastIncomingBody: state.lastIncomingBody,
        reachoutTimelockActive: state.reachoutTimelockActive,
        reachoutTimelockUntil: state.reachoutTimelockUntil,
        reachoutTimelockType: state.reachoutTimelockType,
    };
}

function toSerializable(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value || '');
    }
}

function mapMessageStatus(status) {
    if (status == null) {
        return '';
    }

    if (typeof status === 'number') {
        if (status < 0) {
            return 'error';
        }
        if (status === 0) {
            return 'pending';
        }
        if (status === 1) {
            return 'server';
        }
        if (status === 2) {
            return 'device';
        }
        if (status >= 3) {
            return 'read';
        }
    }

    const normalized = String(status).toUpperCase();
    if (normalized.includes('READ')) {
        return 'read';
    }
    if (normalized.includes('DELIVERY') || normalized.includes('DELIVERED')) {
        return 'device';
    }
    if (normalized.includes('SERVER')) {
        return 'server';
    }
    if (normalized.includes('ERROR') || normalized.includes('FAILED')) {
        return 'error';
    }
    if (normalized.includes('PENDING')) {
        return 'pending';
    }

    return String(status).toLowerCase();
}

function formatBerlinTimestamp(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString('de-DE', {
        timeZone: process.env.TZ || 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function requireAuth(req, res, next) {
    const apiToken = getApiToken();
    if (!apiToken) {
        return res.status(401).json({ error: 'bearer token not configured' });
    }

    const authorization = String(req.headers.authorization || '');
    if (!authorization.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'missing bearer token' });
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (!token || token !== apiToken) {
        return res.status(403).json({ error: 'invalid bearer token' });
    }

    return next();
}

async function clearSessionDirectory() {
    await fs.promises.rm(config.sessionDir, {
        recursive: true,
        force: true,
        maxRetries: 2,
    });
    await fs.promises.mkdir(config.sessionDir, { recursive: true });
}

function scheduleReconnect(reason, delayMs = 3000) {
    if (isShuttingDown || suppressReconnect || reconnectTimer) {
        return;
    }

    console.warn(`Scheduling WhatsApp reconnect in ${delayMs}ms: ${reason}`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void initializeSocket(`reconnect: ${reason}`);
    }, delayMs);
}

async function disconnectActiveSocket(reason, remoteLogout = false) {
    const currentSocket = socket;
    socket = null;

    if (!currentSocket) {
        return;
    }

    try {
        if (remoteLogout && typeof currentSocket.logout === 'function') {
            await currentSocket.logout();
        }
    } catch (error) {
        console.warn(`Socket logout warning: ${error.message}`);
    }

    try {
        currentSocket.ws?.close?.();
    } catch {
        // Ignore socket close problems during teardown.
    }
}

async function resetSocketSession(reason, options = {}) {
    if (resetPromise) {
        return resetPromise;
    }

    resetPromise = (async () => {
        suppressReconnect = true;
        clearReconnectTimer();
        socketGeneration += 1;

        await disconnectActiveSocket(reason, Boolean(options.remoteLogout));

        if (options.clearAuth) {
            await clearSessionDirectory();
        }

        if (options.clearApiToken) {
            clearApiToken();
        } else if (options.clearPairingCode) {
            clearPairingCode();
        }

        updateState({
            status: 'starting',
            qrText: '',
            qrSvg: '',
            account: '',
            lastReadyAt: '',
            lastError: options.clearApiToken ? '' : state.lastError,
            lastSendError: options.clearApiToken ? '' : state.lastSendError,
        });

        suppressReconnect = false;

        if (!isShuttingDown) {
            await initializeSocket(reason);
        }
    })().finally(() => {
        resetPromise = null;
    });

    return resetPromise;
}

async function handleConnectionUpdate(generation, update) {
    if (generation !== socketGeneration) {
        return;
    }

    if (update.qr) {
        await refreshQrSvg(update.qr);
        updateState({
            status: 'qr',
            lastError: '',
        });
    }

    if (update.connection === 'connecting') {
        updateState({
            status: state.qrSvg ? 'qr' : 'connecting',
        });
    }

    if (update.connection === 'open') {
        await refreshQrSvg('');
        updateState({
            status: 'ready',
            account: normalizeAccount(socket?.user?.id),
            lastReadyAt: new Date().toISOString(),
            lastError: '',
            lastSendError: '',
        });
        void refreshReachoutTimelock(socket);
        console.log(`WhatsApp ready as ${state.account || 'unknown account'}`);
        return;
    }

    if (update.connection === 'close') {
        const statusCode = getDisconnectStatusCode(update.lastDisconnect);
        const message = update.lastDisconnect?.error?.message || 'connection closed';
        setLastError(statusCode ? `${message} (code ${statusCode})` : message);

        if (statusCode === DisconnectReason.loggedOut || /logged out/i.test(message)) {
            console.warn('WhatsApp session logged out. Resetting auth and adapter pairing.');
            await resetSocketSession('whatsapp logged out', {
                clearAuth: true,
                clearApiToken: true,
                remoteLogout: false,
            });
            return;
        }

        updateState({
            status: 'disconnected',
        });
        scheduleReconnect(message);
    }
}

function handleMessagesUpsert(payload) {
    if (!payload || !Array.isArray(payload.messages)) {
        return;
    }

    for (const entry of payload.messages) {
        if (!entry || entry.key?.fromMe) {
            continue;
        }

        const body = extractMessageBody(entry.message);
        const remoteJid = String(entry.key?.remoteJid || '');
        const remoteAccount = normalizeAccount(entry.key?.participant || remoteJid);
        if (remoteAccount) {
            rememberChatMapping(remoteAccount, remoteJid);
        }
        updateState({
            lastIncomingAt: new Date().toISOString(),
            lastIncomingFrom: remoteAccount,
            lastIncomingChatId: remoteJid,
            lastIncomingBody: body,
        });
    }
}

function handleMessagesUpdate(payload) {
    if (!Array.isArray(payload)) {
        return;
    }

    for (const entry of payload) {
        if (!entry?.key?.fromMe) {
            continue;
        }

        if (state.lastSendId && entry.key.id !== state.lastSendId) {
            continue;
        }

        const ack = mapMessageStatus(entry.update?.status);
        if (!ack) {
            continue;
        }

        updateState({
            lastSendAck: ack,
            lastSendResolvedTo: String(entry.key?.remoteJid || state.lastSendResolvedTo || ''),
        });
    }
}

async function initializeSocket(reason = 'startup') {
    if (initializePromise || isShuttingDown) {
        return initializePromise;
    }

    initializePromise = (async () => {
        clearReconnectTimer();
        const generation = ++socketGeneration;
        updateState({
            status: 'connecting',
            lastError: state.lastError || '',
        });

        const { state: authState, saveCreds } = await useMultiFileAuthState(config.sessionDir);
        const nextSocket = makeWASocket({
            auth: authState,
            browser: Browsers.ubuntu('ioBroker WhatsApp Bridge'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            logger: pino({ level: config.logLevel }),
        });

        socket = nextSocket;

        nextSocket.ev.on('creds.update', () => {
            void saveCreds().catch(error => {
                console.error(`Cannot save auth credentials: ${error.message}`);
                setLastError(error);
            });
        });

        nextSocket.ev.on('connection.update', update => {
            void handleConnectionUpdate(generation, update).catch(error => {
                console.error(`Connection update error: ${error.message}`);
                setLastError(error);
            });
        });

        nextSocket.ev.on('messages.upsert', handleMessagesUpsert);
        nextSocket.ev.on('messages.update', handleMessagesUpdate);

        console.log(`WhatsApp socket initialized (${reason}).`);
    })().catch(error => {
        updateState({
            status: 'init_error',
        });
        setLastError(error);
        scheduleReconnect(error.message || 'init error', 5000);
        throw error;
    }).finally(() => {
        initializePromise = null;
    });

    return initializePromise;
}

async function refreshReachoutTimelock(currentSocket) {
    if (!currentSocket) {
        return null;
    }

    try {
        const info = await currentSocket.fetchAccountReachoutTimelock();
        const isActive = Boolean(info?.isActive);
        updateState({
            reachoutTimelockActive: isActive,
            reachoutTimelockUntil: isActive ? String(info?.timeEnforcementEnds || '') : '',
            reachoutTimelockType: isActive ? String(info?.enforcementType || '') : '',
        });
        return info;
    } catch (error) {
        console.warn(`Reachout timelock lookup failed: ${error.message}`);
        return null;
    }
}

async function ensureReadySocket() {
    if (!socket) {
        await initializeSocket('lazy send initialization');
    }

    if (!socket || state.status !== 'ready') {
        throw new Error('WhatsApp bridge is not ready yet');
    }

    return socket;
}

async function resolveRecipientJid(currentSocket, phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
        throw new Error('phone number is invalid');
    }

    const pnJid = `${normalizedPhone}@s.whatsapp.net`;
    const lookupInfo = {
        phone: normalizedPhone,
        pnJid,
        onWhatsApp: null,
        lid: '',
    };

    try {
        const checkResult = await currentSocket.onWhatsApp(normalizedPhone);
        lookupInfo.onWhatsApp = toSerializable(checkResult);
        const firstResult = Array.isArray(checkResult) ? checkResult[0] : null;
        if (firstResult?.exists === false) {
            throw new Error('target phone number is not registered on WhatsApp');
        }
    } catch (error) {
        console.warn(`onWhatsApp lookup failed for ${normalizedPhone}: ${error.message}`);
        lookupInfo.onWhatsApp = `lookup failed: ${error.message}`;
    }

    try {
        const existingLid = await currentSocket.signalRepository?.lidMapping?.getLIDForPN?.(pnJid);
        if (existingLid) {
            lookupInfo.lid = String(existingLid);
        } else {
            const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol();
            query.withUser(new USyncUser().withId(pnJid));
            const result = await currentSocket.executeUSyncQuery(query);
            const list = Array.isArray(result?.list) ? result.list : [];
            const lidEntry = list.find(entry => entry?.id === pnJid && entry?.lid) || list.find(entry => entry?.lid);

            if (lidEntry?.lid) {
                lookupInfo.lid = String(lidEntry.lid);
                await currentSocket.signalRepository?.lidMapping?.storeLIDPNMappings?.([
                    {
                        lid: lookupInfo.lid,
                        pn: pnJid,
                    },
                ]);
            }
        }
    } catch (error) {
        console.warn(`LID lookup failed for ${normalizedPhone}: ${error.message}`);
        lookupInfo.lid = '';
    }

    updateState({
        lastSendLookup: JSON.stringify(lookupInfo),
    });

    if (lookupInfo.lid) {
        rememberChatMapping(normalizedPhone, lookupInfo.lid);
    }

    return {
        phone: normalizedPhone,
        jid: lookupInfo.lid || pnJid,
    };
}

async function forceRefreshSession(currentSocket, jid) {
    const normalizedJid = String(jid || '').trim();
    if (!normalizedJid) {
        return;
    }

    const { parseAndInjectE2ESessions } = await getSignalUtils();
    const result = await currentSocket.query({
        tag: 'iq',
        attrs: {
            xmlns: 'encrypt',
            type: 'get',
            to: 's.whatsapp.net',
        },
        content: [
            {
                tag: 'key',
                attrs: {},
                content: [
                    {
                        tag: 'user',
                        attrs: {
                            jid: normalizedJid,
                            reason: 'identity',
                        },
                    },
                ],
            },
        ],
    });

    await parseAndInjectE2ESessions(result, currentSocket.signalRepository);
}

async function sendMessage(phone, text) {
    const currentSocket = await ensureReadySocket();
    const messageText = String(text || '').trim();
    if (!messageText) {
        throw new Error('text is required');
    }

    const target = await resolveRecipientJid(currentSocket, phone);
    const timelock = await refreshReachoutTimelock(currentSocket);
    if (
        timelock?.isActive
        && String(timelock.enforcementType || '').toUpperCase() === 'RESTRICT_ALL_COMPANIONS'
        && target.phone !== state.account
        && !hasKnownChat(target.phone, target.jid)
    ) {
        const untilUtc = String(timelock.timeEnforcementEnds || '');
        const untilBerlin = formatBerlinTimestamp(untilUtc);
        throw new Error(`WhatsApp blockiert diesen Account fuer verknuepfte Geraete bis ${untilBerlin || untilUtc} (${timelock.enforcementType})`);
    }

    try {
        await forceRefreshSession(currentSocket, target.jid);
    } catch (error) {
        console.warn(`Session refresh failed for ${target.jid}: ${error.message}`);
    }
    const sent = await currentSocket.sendMessage(target.jid, { text: messageText });
    const messageId = String(sent?.key?.id || '');

    updateState({
        lastSendAt: new Date().toISOString(),
        lastSendId: messageId,
        lastSendTo: target.phone,
        lastSendResolvedTo: target.jid,
        lastSendAck: 'server',
        lastSendError: '',
    });

    console.log(`Message submitted to ${target.jid} with id ${messageId}`);

    return {
        ok: true,
        phone: target.phone,
        to: target.jid,
        id: messageId,
        ack: 'server',
    };
}

function renderPage() {
    const status = buildStatusPayload();
    const activePairingCode = getActivePairingCode();
    const showPairingSection = !status.authEnabled;
    const qrSection = status.hasQr
        ? `<img src="/qr.svg?ts=${encodeURIComponent(status.lastEventAt)}" alt="WhatsApp QR" style="max-width:320px;width:100%;height:auto;border:1px solid #d0d7de;border-radius:12px;" />`
        : '<p style="margin:0;color:#475467;">Aktuell ist kein QR-Code aktiv.</p>';

    const pairingSection = showPairingSection ? `<section style="margin-top:2rem;padding:1.25rem;border:1px solid #d0d7de;border-radius:14px;background:#f8fafc;">
      <h2 style="margin-top:0;">Adapter koppeln</h2>
      <p style="margin:0 0 1rem 0;color:#475467;">Die Bridge erzeugt hier einen einmaligen Kopplungscode. Diesen Code traegst du dann im ioBroker-Adapter ein.</p>
      <button type="button" id="generate-pairing-code" style="padding:.75rem 1rem;border:0;border-radius:10px;background:#1d4ed8;color:#fff;cursor:pointer;">Kopplungscode generieren</button>
      <button type="button" id="copy-pairing-code" style="display:${activePairingCode?.code ? 'inline-block' : 'none'};padding:.75rem 1rem;border:0;border-radius:10px;background:#0f766e;color:#fff;cursor:pointer;margin-left:.5rem;">Code kopieren</button>
      <div id="pairing-code-display" style="display:${activePairingCode?.code ? 'block' : 'none'};margin-top:1rem;">
        <p style="margin:0 0 .5rem 0;color:#b42318;font-weight:600;">Wichtig: Diesen Code jetzt sichern. Sobald die Bridge mit dem Adapter gekoppelt ist, wird er hier nicht mehr angezeigt.</p>
        <input id="generated-pairing-code" type="text" readonly value="${activePairingCode?.code || ''}" style="width:100%;max-width:520px;padding:.7rem;border:1px solid #d0d7de;border-radius:10px;" />
        <p style="margin:.5rem 0 0 0;color:#475467;">Gueltig bis: <span id="pairing-code-expiry">${activePairingCode?.expiresAt || '-'}</span></p>
      </div>
      <p id="pairing-result" style="margin-top:1rem;"></p>
    </section>` : '';

    const logoutSection = `<section style="margin-top:2rem;padding:1.25rem;border:1px solid #d0d7de;border-radius:14px;background:#fff7ed;">
      <h2 style="margin-top:0;">WhatsApp abmelden</h2>
      <p style="margin:0 0 1rem 0;color:#9a3412;">Beim Abmelden werden WhatsApp-Session und Adapter-Kopplung geloescht. Danach brauchst du wieder einen neuen QR-Code und einen neuen Kopplungscode.</p>
      <form id="logout-form">
        <input id="logout-confirm" type="text" placeholder="Zum Bestaetigen LOGOUT eingeben" style="width:100%;max-width:360px;padding:.7rem;border:1px solid #d0d7de;border-radius:10px;" />
        <button type="submit" style="padding:.75rem 1rem;border:0;border-radius:10px;background:#c4320a;color:#fff;cursor:pointer;margin-left:.5rem;">Jetzt abmelden</button>
      </form>
      <p id="logout-result" style="margin-top:1rem;"></p>
    </section>`;

    return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Bridge</title>
  <style>
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; background: #f4f6f8; color: #101828; }
    .page { max-width: 980px; margin: 0 auto; padding: 2rem 1rem 4rem; }
    .hero { background: linear-gradient(135deg, #0f172a, #14532d); color: #fff; border-radius: 20px; padding: 1.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .card { background: #fff; border-radius: 16px; padding: 1.25rem; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); }
    code { background: #eef2f6; padding: .15rem .35rem; border-radius: 6px; }
    a { color: inherit; }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <h1 style="margin:.2rem 0 0 0;">WhatsApp Bridge</h1>
      <p style="margin:.75rem 0 0 0;max-width:720px;">Die Bridge laeuft getrennt von ioBroker und uebernimmt die WhatsApp-Verbindung. Die Adapter-Kopplung erfolgt ueber einen einmaligen Code, ohne dass du das echte Zugriffstoken manuell verwalten musst.</p>
    </section>

    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0;">Status</h2>
        <p><strong>Bridge:</strong> <span id="status-value">${status.status}</span></p>
        <p><strong>Account:</strong> ${status.account || '-'}</p>
        <p><strong>Letztes Ready:</strong> ${status.lastReadyAt || '-'}</p>
        <p><strong>Letztes Event:</strong> ${status.lastEventAt || '-'}</p>
        <p><strong>Adapter gekoppelt:</strong> ${status.authEnabled ? 'Ja' : 'Nein'}</p>
        <p><strong>Letzter Fehler:</strong> ${status.lastError || '-'}</p>
      </section>

      <section class="card">
        <h2 style="margin-top:0;">WhatsApp QR</h2>
        <p style="margin-top:0;color:#475467;">Solange die Bridge nicht angemeldet ist, erscheint hier der QR-Code fuer dein Handy.</p>
        ${qrSection}
      </section>
    </div>

    ${pairingSection}
    ${logoutSection}

    <section class="card" style="margin-top:1rem;">
      <h2 style="margin-top:0;">Ablauf</h2>
      <ol style="padding-left:1.25rem;margin-bottom:0;">
        <li>Wenn noetig QR-Code mit WhatsApp am Handy scannen.</li>
        <li>Hier einen Kopplungscode erzeugen und sichern.</li>
        <li>Diesen Code im ioBroker-Adapter unter <code>Bridge koppeln</code> eintragen.</li>
        <li>Danach koennen Nachrichten ueber die konfigurierten <code>sendMessage.*</code>-States verschickt werden.</li>
      </ol>
    </section>
  </div>

  <script>
    const pairingResult = document.getElementById('pairing-result');
    const generateButton = document.getElementById('generate-pairing-code');
    const copyButton = document.getElementById('copy-pairing-code');
    const generatedCode = document.getElementById('generated-pairing-code');
    const codeDisplay = document.getElementById('pairing-code-display');
    const codeExpiry = document.getElementById('pairing-code-expiry');

    if (generateButton) {
      generateButton.addEventListener('click', async () => {
        pairingResult.textContent = 'Kopplungscode wird erzeugt...';
        try {
          const response = await fetch('/pair/code/generate', { method: 'POST' });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Kopplungscode konnte nicht erzeugt werden');
          }

          generatedCode.value = data.code || '';
          codeExpiry.textContent = data.expiresAt || '-';
          codeDisplay.style.display = data.code ? 'block' : 'none';
          copyButton.style.display = data.code ? 'inline-block' : 'none';
          pairingResult.textContent = 'Neuer Kopplungscode wurde erzeugt. Bitte jetzt sichern.';
        } catch (error) {
          pairingResult.textContent = 'Fehler: ' + error.message;
        }
      });
    }

    if (copyButton) {
      copyButton.addEventListener('click', async () => {
        if (!generatedCode || !generatedCode.value) {
          pairingResult.textContent = 'Kein Kopplungscode zum Kopieren vorhanden.';
          return;
        }

        try {
          await navigator.clipboard.writeText(generatedCode.value);
          pairingResult.textContent = 'Kopplungscode wurde in die Zwischenablage kopiert.';
        } catch {
          pairingResult.textContent = 'Kopieren fehlgeschlagen. Bitte den Code manuell markieren und kopieren.';
        }
      });
    }

    const form = document.getElementById('logout-form');
    const result = document.getElementById('logout-result');
    if (form) {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const confirmInput = document.getElementById('logout-confirm');
        if (!confirmInput || confirmInput.value.trim().toUpperCase() !== 'LOGOUT') {
          result.textContent = 'Bitte zur Sicherheit genau LOGOUT eingeben.';
          return;
        }

        result.textContent = 'Bridge wird abgemeldet...';

        try {
          const response = await fetch('/logout/ui', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: '${logoutNonce}', confirmText: confirmInput.value })
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Logout fehlgeschlagen');
          }
          result.textContent = 'Bridge wurde abgemeldet. Die Seite laedt jetzt neu.';
          setTimeout(() => window.location.reload(), 1500);
        } catch (error) {
          result.textContent = 'Fehler: ' + error.message;
        }
      });
    }
  </script>
</body>
</html>`;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
    res.type('html').send(renderPage());
});

app.get('/health', (_req, res) => {
    res.json(buildStatusPayload());
});

app.get('/debug/lookup', requireAuth, async (req, res) => {
    try {
        const currentSocket = await ensureReadySocket();
        const phone = String(req.query.phone || '').trim();
        if (!phone) {
            return res.status(400).json({ error: 'phone is required' });
        }

        const normalizedPhone = normalizePhone(phone);
        if (!normalizedPhone) {
            return res.status(400).json({ error: 'phone number is invalid' });
        }

        const checkResult = await currentSocket.onWhatsApp(normalizedPhone);
        return res.json({
            ok: true,
            phone: normalizedPhone,
            defaultJid: `${normalizedPhone}@s.whatsapp.net`,
            lookup: toSerializable(checkResult),
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.get('/debug/reachout', requireAuth, async (_req, res) => {
    try {
        const currentSocket = await ensureReadySocket();
        const [timelock, cap] = await Promise.all([
            currentSocket.fetchAccountReachoutTimelock(),
            currentSocket.fetchNewChatMessageCap(),
        ]);

        return res.json({
            ok: true,
            timelock: toSerializable(timelock),
            cap: toSerializable(cap),
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/pair/code/generate', (_req, res) => {
    try {
        if (getApiToken()) {
            return res.status(409).json({ error: 'adapter already paired; logout first to generate a new pairing code' });
        }

        const pairingCode = generatePairingCode();
        return res.json({
            ok: true,
            code: pairingCode?.code || '',
            expiresAt: pairingCode?.expiresAt || '',
        });
    } catch (error) {
        setLastError(error);
        return res.status(500).json({ error: error.message });
    }
});

app.post('/pair/complete', (req, res) => {
    try {
        if (getApiToken()) {
            return res.status(409).json({ error: 'adapter already paired; logout first to pair again' });
        }

        const submittedCode = String(req.body?.code || '').trim().toUpperCase();
        if (!submittedCode) {
            return res.status(400).json({ error: 'pairing code is required' });
        }

        const pairingCode = getActivePairingCode();
        if (!pairingCode?.code) {
            return res.status(404).json({ error: 'no active pairing code available' });
        }

        if (submittedCode !== String(pairingCode.code).trim().toUpperCase()) {
            return res.status(401).json({ error: 'invalid pairing code' });
        }

        const token = generateApiToken();
        return res.json({
            ok: true,
            token,
        });
    } catch (error) {
        setLastError(error);
        return res.status(500).json({ error: error.message });
    }
});

app.get('/qr.svg', (_req, res) => {
    if (!state.qrSvg) {
        return res.status(404).type('text/plain').send('no qr available');
    }

    return res.type('image/svg+xml').send(state.qrSvg);
});

app.post('/send', requireAuth, async (req, res) => {
    try {
        const text = String(req.body?.text || '').trim();
        const phone = String(req.body?.phone || '').trim();

        if (!text) {
            return res.status(400).json({ error: 'text is required' });
        }

        if (!phone) {
            return res.status(400).json({ error: 'phone is required' });
        }

        const result = await sendMessage(phone, text);
        return res.json(result);
    } catch (error) {
        updateState({
            lastSendAt: new Date().toISOString(),
            lastSendError: error.message,
            lastSendAck: 'error',
        });
        setLastError(error);
        return res.status(500).json({ error: error.message });
    }
});

app.post('/logout', requireAuth, async (_req, res) => {
    try {
        await resetSocketSession('api logout requested', {
            clearAuth: true,
            clearApiToken: true,
            remoteLogout: true,
        });
        return res.json({
            ok: true,
            status: buildStatusPayload(),
        });
    } catch (error) {
        setLastError(error);
        return res.status(500).json({ error: error.message });
    }
});

app.post('/logout/ui', async (req, res) => {
    try {
        const nonce = String(req.body?.nonce || '').trim();
        const confirmText = String(req.body?.confirmText || '').trim().toUpperCase();

        if (nonce !== logoutNonce) {
            return res.status(403).json({ error: 'invalid logout nonce' });
        }

        if (confirmText !== 'LOGOUT') {
            return res.status(400).json({ error: 'please confirm with LOGOUT' });
        }

        logoutNonce = crypto.randomBytes(16).toString('hex');
        await resetSocketSession('ui logout requested', {
            clearAuth: true,
            clearApiToken: true,
            remoteLogout: true,
        });

        return res.json({
            ok: true,
            status: buildStatusPayload(),
        });
    } catch (error) {
        setLastError(error);
        return res.status(500).json({ error: error.message });
    }
});

const server = app.listen(config.port, config.host, () => {
    console.log(`WhatsApp bridge listening on http://${config.host}:${config.port}`);
    void initializeSocket('startup').catch(error => {
        console.error(`Initial socket startup failed: ${error.message}`);
    });
});

async function shutdown(signal) {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    suppressReconnect = true;
    clearReconnectTimer();
    console.log(`Received ${signal}, shutting down.`);

    try {
        await disconnectActiveSocket(`shutdown: ${signal}`, false);
    } catch {
        // Ignore shutdown cleanup errors.
    }

    await new Promise(resolve => {
        server.close(() => resolve());
    });

    process.exit(0);
}

process.on('SIGINT', () => {
    void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
