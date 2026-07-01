FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3008 \
    HOST=0.0.0.0 \
    SESSION_DIR=/data/session \
    RUNTIME_CONFIG_PATH=/data/bridge-config.json

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /data/session

EXPOSE 3008
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3008') + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
