# ---- build stage -------------------------------------------------------------
# argon2 is a native module. It normally installs a prebuilt binary, but when one
# is missing for the platform it compiles from source, which needs python3 and a
# C++ toolchain. Building here keeps those out of the final image.
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim

# ffmpeg/ffprobe are required: every upload is probed, thumbnailed and re-encoded.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY web ./web

# Writable paths for uploads in flight and, with STORAGE_DRIVER=local, the media files.
RUN mkdir -p /app/server/tmp /app/server/storage-data \
 && chown -R node:node /app/server/tmp /app/server/storage-data

ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER node
WORKDIR /app/server

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-4000}/healthz" || exit 1

CMD ["node", "src/index.js"]
