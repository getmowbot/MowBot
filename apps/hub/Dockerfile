# syntax=docker/dockerfile:1
# Build context: repository root.
FROM node:24-slim AS build
RUN npm install --global pnpm@11.4.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/hub/package.json apps/hub/
COPY packages/contract/package.json packages/contract/
RUN pnpm install --frozen-lockfile --filter "@mowbot/hub..."
COPY packages/contract packages/contract
COPY apps/hub apps/hub
RUN pnpm --filter @mowbot/hub build \
  && pnpm --filter @mowbot/hub deploy --prod --legacy /out \
  && rm -rf /out/dist && cp -r apps/hub/dist /out/dist

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# Owned by `node` (uid 1000, same as the computers' `bot`) so a fresh volume mounted here is writable.
RUN mkdir -p /data/workspaces && chown node:node /data/workspaces
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
