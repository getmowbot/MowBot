# syntax=docker/dockerfile:1
# Build context: repository root.
#   docker build -f workstation/mcp.Dockerfile -t mowbot/mcp:local .
# The MCP computer: where the MCP servers run, apart from the bots' computers. No desktop, no
# browser: Node 24 (npx), Python 3 with pipx and uv (uvx), git, and mow-agent, which bridges a
# server's stdio to the hub and runs the Chef's setup commands. Its home is a volume: installs,
# caches and the servers' own settings and sign-ins outlive a new image.

FROM node:24-slim AS agent
RUN npm install --global pnpm@11.4.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --filter "@mowbot/agent..."
COPY apps/agent apps/agent
RUN pnpm --filter @mowbot/agent build

FROM node:24-slim AS node

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Etc/UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git openssh-client unzip zip jq less nano procps sudo \
      python3 python3-pip python3-venv pipx \
    && rm -rf /var/lib/apt/lists/*

# Node 24 with npm and npx.
COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

# uv and uvx, for everyone (Python servers are often run with `uvx <package>`).
RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install uv \
    && chmod -R a+rX /opt/pipx

# The `bot` user (uid 1000, like the hub's `node` user so workspace files line up) with sudo.
# What it installs (pipx, uv tool, npm -g) lands in its home, which is kept.
RUN userdel --remove ubuntu \
    && useradd --create-home --uid 1000 --shell /bin/bash bot \
    && echo 'bot ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bot \
    && chmod 0440 /etc/sudoers.d/bot \
    && mkdir -p /workspace /home/bot/.local/bin \
    && chown -R bot:bot /workspace /home/bot

COPY --from=agent /repo/apps/agent/dist/agent.cjs /opt/mowbot/agent.cjs

USER bot
ENV HOME=/home/bot \
    USER=bot \
    PATH=/home/bot/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/home/bot/.local \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /workspace
EXPOSE 7070
CMD ["node", "/opt/mowbot/agent.cjs"]
