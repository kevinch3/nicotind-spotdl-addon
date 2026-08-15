# The spotDL acquisition addon — NicotinD acquisition addon protocol v1.
FROM oven/bun:1.3.14

# spotDL needs Python + ffmpeg; it drives yt-dlp under the hood, which needs a JS
# runtime (Deno) to solve YouTube's player-signature challenges and the bgutil
# PO-token provider plugin to fetch tokens from the pot-provider sidecar. Pin the
# provider plugin to the sidecar image (mirror the monorepo's BGUTIL_VERSION).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

# Deno — spotDL's embedded yt-dlp needs a JS runtime for signature challenges.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# spotDL is unpinned (latest) — it and its embedded yt-dlp track YouTube's
# continuous breakage, matching the monorepo's own image. BGUTIL_VERSION pins the
# provider plugin to the pot-provider sidecar image (same default as the monorepo;
# override to move both in lockstep).
ARG BGUTIL_VERSION=1.3.1
RUN pip3 install --no-cache-dir --break-system-packages --upgrade \
  spotdl \
  "bgutil-ytdlp-pot-provider==${BGUTIL_VERSION}"

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src

ENV SPOTDL_ADDON_BINARY=spotdl \
    SPOTDL_ADDON_DOWNLOADS_DIR=/data/downloads \
    SPOTDL_ADDON_PORT=8587

EXPOSE 8587

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS "http://127.0.0.1:${SPOTDL_ADDON_PORT}/addon/v1/health" | grep -q '"ok":true' || exit 1

CMD ["bun", "run", "src/main.ts"]
