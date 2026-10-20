# syntax=docker/dockerfile:1
# Build context: repository root. Serves the web app and proxies /api to the hub.
FROM node:24-slim AS build
RUN npm install --global pnpm@11.4.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
COPY packages/api-client/package.json packages/api-client/
RUN pnpm install --frozen-lockfile --filter "@mowbot/web..."
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @mowbot/web build

FROM caddy:2
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv/web
