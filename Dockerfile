# ──────────────────────────────────────────────────────────────────────────────
# Production image — system Chromium, not Puppeteer-managed.
#
# Why system Chromium instead of Puppeteer's bundled binary on Render:
#   • The bundled binary is downloaded into Render's persistent workspace volume.
#     A partial / interrupted download leaves a half-extracted version folder,
#     and Puppeteer's installer skips re-downloads when the folder already exists.
#     Result: the broken state is sticky across every redeploy.
#   • The apt-installed Chromium is part of the immutable image layer, not the
#     workspace. Every container start gets a guaranteed-good binary.
#   • This is the conventional pattern for Puppeteer in production containers.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:20-slim

# Chromium + the fonts/libs it needs to render real-world pages.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's own Chromium download — we use the apt-installed one.
# These env vars must be set BEFORE `npm ci` so postinstall honors them.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Install dependencies first so this layer caches across code-only redeploys.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then copy the source.
COPY . .

# Render injects PORT into the process; we read it in server.js via process.env.PORT.
# The EXPOSE here is informational only.
EXPOSE 10000

CMD ["npm", "start"]
