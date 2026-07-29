# OCU API facade — runs on the official Playwright image, which already ships a
# matching Chromium + all system libraries the headless browser needs. Keep the
# image tag in lockstep with the "playwright" version in package.json.
ARG PLAYWRIGHT_VERSION=v1.48.2-jammy

# ── build stage ───────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ─────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# Non-secret defaults; real values come from the environment / compose / secrets.
ENV PORT=38300 \
    DRIVER=scraper \
    OPAL_URL=https://opal-kurier.de \
    OPAL_USER_DATA_DIR=/app/.browser-data

EXPOSE 38300
CMD ["node", "dist/server.js"]
