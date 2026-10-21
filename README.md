<div align="center">

# MowBot

**Self-hosted teams of AI bots that share real computers.**

[![CI](https://github.com/getmowbot/MowBot/actions/workflows/ci.yml/badge.svg)](https://github.com/getmowbot/MowBot/actions/workflows/ci.yml)
[![Desktop app](https://img.shields.io/github/v/release/getmowbot/MowBot?label=desktop%20app)](https://github.com/getmowbot/MowBot/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[Français](docs/README.fr.md) · [Specification](docs/SPEC.md) · [Roadmap](docs/ROADMAP.md) · [Desktop app](docs/DESKTOP.md)

</div>

MowBot runs on your own server. You talk to a **Chef** bot; it builds **teams of bots**, gives
them missions and coordinates them. Each team shares a **real Linux PC** (desktop, Chrome,
`sudo`) and a workspace of files you can browse. Bots work at the same time, talk to each other,
act on their own, share their logins safely, use MCP servers, and can work on the projects of
**your own computer** through the desktop app. You choose the models: an API key, a subscription,
or a local model.

## What it does

**Teams and computers**
- Several teams, each with its PC (a Docker workstation: XFCE, VNC, Chrome, `sudo`) and its
  workspace; solo bots get their own PC. Bots share the PC without getting in each other's way:
  each has its own Chrome window, its shell sessions, file locks and a queue for the screen.
- Watch any PC live and take control from the app; bots ask you when they need a login, a 2FA
  code or a captcha.

**Conversations**
- Streaming answers with the bot's actions folded in. Messages sent while a bot works are taken
  into account at its next step; a bot can stop another one.
- Bots show rather than describe: cards with images and buttons, galleries, files, scores,
  checklists, routes. `@` points at a bot, a team or a file; `/` runs a command (`/stop`,
  `/clear`, `/pc`, `/files`…).
- Characters with moods: each bot is a little creature that thinks, reads, waits, sleeps and
  beams when it is done.

**On their own**
- Routines (cron, interval, webhook), periodic check-ins, an evening summary, budgets and a
  global pause.
- Automations: small scripts the hub runs on a bot's PC without waking the model (live scores,
  price watching), updating a card and notifying you.
- Push notifications on your phone when a bot is done or needs you.

**Vault**
- Envelope-encrypted logins, secrets and website sessions. A session opened on one PC can be used
  on another; values reach websites and commands through placeholders and are never shown to
  the models. Bots ask you for a password with a masked form that goes straight to the vault.

**Tools and your projects**
- MCP servers: remote (with OAuth) or local, run on a bot's PC; a bot can install one itself.
- The **desktop app** shares folders of your computer as projects, even when the hub is on a
  remote server. Bots read, edit, search and run commands there (commands with your approval,
  or freely in auto mode), or copy the project to their PC to install and test it and bring
  their changes back as a **git branch** of your repository.

**Apps**
- Web, desktop (Windows, macOS, Linux; updates itself) and mobile (iOS, Android), in English and
  French. Every client is a peer of the secured REST API (OpenAPI 3.1).

## Install the server

On a Linux server (Ubuntu, Debian, Fedora…), one command installs everything, and the same
command updates it:

```bash
curl -fsSL https://raw.githubusercontent.com/getmowbot/MowBot/main/install.sh | sudo bash
```

The script installs Docker if needed, asks for the address (a public domain served over HTTPS
with an automatic certificate, or nothing for your local network over HTTP), writes
`deploy/.env` with generated keys, builds the images (hub, web, the bots' PC) and starts
everything. The first run takes 10 to 20 minutes. It ends with the address and the **setup
token** to create your account.

Non-interactive options: `--domain mowbot.example.com`, `--lan`, `--port 8080`, `--yes`,
`--dir /opt/mowbot`.

It also installs the `mowbot` command:

| Command | What it does |
|---|---|
| `sudo mowbot update` | Pulls the code, rebuilds the images and restarts. Settings and data stay. |
| `sudo mowbot status` | Services and address |
| `sudo mowbot logs [hub]` | Live logs |
| `sudo mowbot stop` / `start` / `restart` | Stop (the bots' PCs included), start again |

> **Back up `deploy/.env`.** Its `MOWBOT_MASTER_KEY` encrypts the vault: without it, secrets
> cannot be read.

Then open the address, create your account with the setup token, and add a model in
**Models**.

## Models

| Provider | How |
|---|---|
| OpenAI | API key |
| Command Code | your subscription key |
| Any OpenAI-compatible API | OpenRouter, Ollama, vLLM, xAI, DeepSeek… (base URL + key) |

Each bot has its model, fallback models and a lighter model for check-ins. Pick a model that
accepts images for screenshots.

## Desktop app

Download it from the [latest release](https://github.com/getmowbot/MowBot/releases/latest):
`.exe` / `.msi` for Windows, `.dmg` for macOS, AppImage / `.deb` for Linux. On Linux, one
command installs it and points it at your hub:

```bash
curl -fsSL https://raw.githubusercontent.com/getmowbot/MowBot/main/apps/desktop/install-linux.sh | sh -s -- --hub https://mowbot.example.com
```

On first launch it asks for your hub's address (the web interface's). In **Settings →
Projects**, link the computer, then share a folder. The app keeps running in the tray so bots
can reach your projects, and it updates itself when a new version is out. See
[docs/DESKTOP.md](docs/DESKTOP.md) for the protocol and the security model.

## Mobile app

> **In development.** The iOS and Android app is coming soon to TestFlight / the App Store and
> to Android. Until then, you can already use it through **Expo Go**.

The app (`apps/mobile`, Expo SDK 57) does everything the web app does: conversations, the bots'
PCs live with take-over, teams, files, the vault, MCP servers, routines and push notifications.
To run it in [Expo Go](https://expo.dev/go) from a clone of this repository:

```bash
pnpm install
pnpm --filter @mowbot/mobile start
```

Scan the QR code with Expo Go (phone on the same network), then sign in with your hub's address
and password.

## Development

Requirements: Node 24+ and pnpm 11. No Docker needed for the account, the API and files (the
database runs locally with PGlite); the bots' PCs need Docker and the workstation image.

```bash
pnpm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # MOWBOT_MASTER_KEY in .env
pnpm dev
```

- Web: http://localhost:5173 (proxies `/api` to the hub)
- Hub: http://localhost:8787/api/v1/health, OpenAPI at `/api/v1/openapi.json`
- On first start the hub prints the setup token in its logs.
- Bots' PCs: `docker build -f workstation/Dockerfile -t mowbot/workstation:local .`

| Command | |
|---|---|
| `pnpm dev` | Hub and web in watch mode |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm typecheck` | TypeScript in every package |
| `pnpm test` | Vitest (in-memory PGlite) |
| `pnpm build` | Hub bundle and web build |
| `pnpm openapi` | Regenerates the OpenAPI document and the TypeScript client |
| `pnpm --filter @mowbot/hub db:generate` | New migration after a `schema.ts` change |
| `pnpm --filter @mowbot/desktop start` | Desktop app in development (Rust toolchain needed) |

```
apps/hub              Fastify API: auth, teams, computers (Docker), agents, vault, MCP, projects
apps/agent            mow-agent, the daemon inside each bot PC (screen, input, shell, browser)
apps/web              Web app (Vite, React, TanStack)
apps/mobile           iOS / Android app (Expo)
apps/desktop          Desktop app (Tauri): the web app plus the Rust connector for local projects
packages/contract     Shared zod schemas, the source of truth of the API
packages/api-client   TypeScript client generated from the OpenAPI document
packages/design       Design tokens and the bots' characters (shared by every app)
workstation/          Docker image of the bots' PCs
deploy/               Production docker-compose and Caddy
```

## Security model

- The API is the only door: devices get short access tokens and rotating refresh tokens, with
  scopes; the web app keeps its refresh token in an httpOnly cookie.
- A team's PC is a shared trust zone: its bots see each other's files and sessions. Give a bot
  sensitive work on a dedicated PC, or in an isolated team.
- Model API keys never enter the bots' PCs; vault values never reach the models.
- The desktop app only works inside the folders you shared, checks every path, and asks before
  running a command unless you allow it.

## License

MowBot is free software under the [GNU Affero General Public License v3.0](LICENSE).
Copyright © 2026 Joris Levasseur.
