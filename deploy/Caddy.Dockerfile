# syntax=docker/dockerfile:1
# Build context: repository root. Serves the web app, proxies /api to the hub, and serves the
# bots' web previews on MOWBOT_PREVIEW_PORTS (proxied to the same ports of the hub).
FROM node:24-slim AS build
RUN npm install --global pnpm@11.4.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
COPY packages/api-client/package.json packages/api-client/
COPY packages/design/package.json packages/design/
RUN pnpm install --frozen-lockfile --filter "@mowbot/web..."
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @mowbot/web build

FROM caddy:2
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/caddy-start.sh /usr/local/bin/mowbot-caddy
COPY --from=build /repo/apps/web/dist /srv/web
CMD ["/usr/local/bin/mowbot-caddy"]
