FROM node:22-bookworm-slim

ENV PUPPETEER_CACHE_DIR=/opt/puppeteer-cache \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    WA_HISTORY_AUTH_PATH=/mnt/whatsapp-auth

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx puppeteer browsers install chrome \
    && npm run build \
    && mkdir -p .next/standalone/.next/static \
    && cp -a .next/static/. .next/standalone/.next/static/ \
    && mkdir -p /mnt/whatsapp-auth \
    && chown -R node:node /app /opt/puppeteer-cache /mnt/whatsapp-auth

USER node

EXPOSE 8080
CMD ["node", ".next/standalone/server.js"]
