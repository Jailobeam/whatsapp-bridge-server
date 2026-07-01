# WhatsApp Bridge Server

Self-hosted WhatsApp bridge for [ioBroker.whatsapp-bridge](https://github.com/Jailobeam/ioBroker.whatsapp-bridge).

This service keeps the WhatsApp runtime outside ioBroker. The ioBroker adapter only talks to this bridge over HTTP.

## What it does

- hosts one WhatsApp multi-device session
- shows the QR code in a small web UI
- generates one-time pairing codes for the ioBroker adapter
- stores the real adapter access token only internally after pairing
- sends messages through `POST /send`
- supports logout and clean re-pairing for a different phone number
- runs well in Docker with one persistent data volume
- uses Baileys directly over WebSocket, without Chromium or Puppeteer

## Recommended deployment

Docker is the recommended deployment format here.

Why this is now lighter:

- no browser runtime is required anymore
- no Chromium shared libraries are needed on the host
- RAM usage is much lower than the old browser-based bridge
- the Docker image is smaller and simpler to move between systems

## Quick start with Docker Compose

Create `.env` from the template:

```bash
cp .env.example .env
```

Start the container:

```bash
docker compose up -d --build
```

Open the web UI:

```text
http://<server-ip>:3008
```

Recommended order:

1. Open the bridge web UI.
2. Scan the WhatsApp QR code if the bridge is not connected yet.
3. Click `Kopplungscode generieren`.
4. Copy the generated code.
5. Open the ioBroker adapter admin page.
6. Paste the code into `Kopplungscode aus der Bridge` and click `Bridge koppeln`.
7. Save the adapter settings.

After successful pairing, the code is no longer shown in the UI.
After logout, both the session and the adapter pairing are removed. A new pairing code must be generated before pairing again.

## Direct Docker run

Build first:

```bash
docker build -t whatsapp-bridge-server:local .
```

```bash
docker run -d \
  --name whatsapp-bridge \
  --restart unless-stopped \
  -p 3008:3008 \
  --env-file .env \
  -v whatsapp-bridge-data:/data \
  whatsapp-bridge-server:local
```

## Persistent data

The container stores everything important in `/data`:

- WhatsApp auth/session files
- internal adapter token and optional pairing code in `bridge-config.json`

If you remove the volume, the bridge starts fresh and needs a new pairing code and a new QR pairing.

## API

`GET /health`

Returns the current bridge state.

`GET /`

Small browser UI with QR code, token generation and logout.

`GET /qr.svg`

Returns the active QR code as SVG while pairing is required.

`POST /send`

Headers:

```text
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "text": "Hello from ioBroker",
  "phone": "+<target-number>"
}
```

`POST /logout`

Logs out the current WhatsApp session, clears the stored adapter pairing and returns the bridge to QR mode.

`POST /pair/code/generate`

Generates a new one-time pairing code while the bridge is not already paired with an adapter.

`POST /pair/complete`

Accepts the one-time pairing code and returns the real internal adapter token to the ioBroker adapter.

## GitHub Container Registry

The repository includes a GitHub Actions workflow that can publish multi-arch Docker images to:

```text
ghcr.io/jailobeam/whatsapp-bridge-server
```

The workflow publishes on:

- pushes to `master`
- version tags like `v1.0.0`
- manual workflow dispatch

## Notes

- The service is designed for one WhatsApp account.
- Phone numbers must include the country code.
- Recipients are sent in the normal WhatsApp user format `<countrycode><number>@s.whatsapp.net`.
- The real adapter token is stored at runtime only and is not part of `.env.example`.
