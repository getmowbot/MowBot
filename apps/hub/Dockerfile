# syntax=docker/dockerfile:1
# Build context: repository root.
FROM node:24-slim AS build
RUN npm install --global pnpm@11.4.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/hub/package.json apps/hub/
COPY packages/contract/package.json packages/contract/
COPY packages/design/package.json packages/design/
# Only a test dependency of the hub, but pnpm resolves it when deploying.
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --filter "@mowbot/hub..."
COPY packages/contract packages/contract
COPY packages/design packages/design
COPY apps/hub apps/hub
RUN pnpm --filter @mowbot/hub build \
  && pnpm --filter @mowbot/hub deploy --prod --legacy /out \
  && rm -rf /out/dist && cp -r apps/hub/dist /out/dist
# The ONNX runtime (speech recognition) ships for every OS: only Linux is kept.
RUN find /out/node_modules -type d -path '*onnxruntime-node/bin/napi-v*/*' \
  \( -name darwin -o -name win32 \) -prune -exec rm -rf {} +

FROM node:24-slim
ENV NODE_ENV=production
# ffmpeg decodes voice messages (webm, m4a…) for Whisper; the model is downloaded once to
# /data/models on first use.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV MOWBOT_MODELS_DIR=/data/models
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# Owned by `node` (uid 1000, same as the computers' `bot`) so a fresh volume mounted here is writable.
RUN mkdir -p /data/workspaces /data/models && chown node:node /data/workspaces /data/models
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
