# syntax=docker/dockerfile:1
# Build context: repository root.
#   docker build -f workstation/Dockerfile -t mowbot/workstation:local .
# The Linux computer a team (or a dedicated bot) works on: XFCE desktop over VNC, Chrome,
# sudo, and mow-agent, the daemon the hub drives.

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
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Etc/UTC \
    DISPLAY=:0

RUN apt-get update && apt-get install -y --no-install-recommends \
      xfce4 xfce4-terminal dbus-x11 at-spi2-core \
      tigervnc-standalone-server x11-utils x11-xserver-utils \
      xdotool scrot xclip \
      supervisor sudo tmux curl wget ca-certificates gnupg git unzip zip jq \
      less nano vim-tiny procps psmisc htop python3 python3-pip python3-venv \
      fonts-dejavu fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome only ships for amd64; other architectures run without a browser for now.
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Node 24 with npm, for mow-agent and for the bots themselves.
COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

# The `bot` user (uid 1000, like the hub's `node` user so workspace files line up) with sudo.
RUN userdel --remove ubuntu \
    && useradd --create-home --uid 1000 --shell /bin/bash bot \
    && echo 'bot ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bot \
    && chmod 0440 /etc/sudoers.d/bot \
    && mkdir -p /workspace \
    && chown bot:bot /workspace

COPY workstation/rootfs/ /
COPY --from=agent /repo/apps/agent/dist/agent.cjs /opt/mowbot/agent.cjs
RUN chmod 0755 /usr/local/bin/mowbot-*

WORKDIR /workspace
EXPOSE 7070
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/mowbot.conf"]
