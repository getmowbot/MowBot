# MowBot

Des équipes de bots IA self-hosted. Chaque équipe partage un vrai PC Linux (bureau, navigateur, `sudo`) et un workspace de fichiers ; un bot **Chef** crée les équipes, distribue les missions et coordonne. Les bots sont proactifs, se parlent, se partagent leurs accès et utilisent des serveurs MCP.

- Spécification : [docs/SPEC.md](docs/SPEC.md)
- Roadmap : [docs/ROADMAP.md](docs/ROADMAP.md)

> **État : P0 (fondations).** Compte propriétaire, appareils, API sécurisée et shell web. Les bots, ordinateurs et équipes arrivent dans les phases suivantes.

## Structure

```
apps/hub              API Fastify (auth, devices, OpenAPI) — le futur cerveau des bots
apps/web              App web (Vite + React + TanStack)
packages/contract     Schémas zod partagés (source de vérité des types de l'API)
packages/api-client   Client TypeScript généré depuis l'OpenAPI (web, futures apps mobile/desktop)
deploy/               docker-compose de production, Caddy
docs/                 Spécification et roadmap
```

## Développement local

Prérequis : Node 24+, pnpm 11. Pas besoin de Docker : la base tourne en local avec PGlite.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Renseigne `MOWBOT_MASTER_KEY` dans `.env` (32 octets en base64) :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
pnpm dev
```

- Web : http://localhost:5173 (proxifie `/api` vers le hub)
- Hub : http://localhost:8787/api/v1/health — OpenAPI sur `/api/v1/openapi.json`

Au premier lancement, le hub affiche dans ses logs le **jeton de configuration** à saisir sur la page de setup (ou utilise `MOWBOT_SETUP_TOKEN` s'il est défini).

### Commandes

| Commande | Rôle |
|---|---|
| `pnpm dev` | Hub + web en mode watch |
| `pnpm lint` / `pnpm format` | Biome (vérification / correction) |
| `pnpm typecheck` | TypeScript sur tous les packages |
| `pnpm test` | Tests (Vitest, base PGlite en mémoire) |
| `pnpm build` | Bundle du hub + build du web |
| `pnpm openapi` | Régénère `openapi.json` et le client TS après un changement d'API |
| `pnpm --filter @mowbot/hub db:generate` | Génère une migration après un changement de `schema.ts` |

## Production

Sur un serveur Linux avec Docker :

```bash
cp deploy/.env.example deploy/.env
```

Remplis `deploy/.env` (domaine, mot de passe Postgres, clé maître), puis :

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Caddy sert le web et l'API en HTTPS (certificat automatique pour un domaine public). Récupère le jeton de configuration avec :

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs hub
```

**Sauvegarde `MOWBOT_MASTER_KEY`** : sans elle, les secrets chiffrés sont illisibles.
