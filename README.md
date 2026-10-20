# MowBot

Des équipes de bots IA self-hosted. Chaque équipe partage un vrai PC Linux (bureau, navigateur, `sudo`) et un workspace de fichiers ; un bot **Chef** crée les équipes, distribue les missions et coordonne. Les bots sont proactifs, se parlent, se partagent leurs accès et utilisent des serveurs MCP.

- Spécification : [docs/SPEC.md](docs/SPEC.md)
- Roadmap : [docs/ROADMAP.md](docs/ROADMAP.md)

> **État : P4 et P3b.**
> - Les bots agissent d'eux-mêmes : routines (cron, intervalle, webhook), réveils périodiques, notifications et bilan du soir, budgets et pause globale.
> - Ils épinglent leurs résultats sur la page d'accueil (score, liste de courses, chiffres…) et te posent leurs questions avec des réponses en boutons.
> - Chaque bot navigue dans sa propre fenêtre de Chrome, sans prendre l'écran, et tu la vois en direct.
> - Les équipes de bots se parlent, se confient des tâches et s'échangent des fichiers, sur des PC Linux partagés.
> - L'API est sécurisée ; l'interface est en français et en anglais.
>
> Prochaine étape : le coffre de sessions (P5).

## Structure

```
apps/hub              API Fastify : auth, appareils, équipes, ordinateurs (Docker), fichiers, événements
apps/agent            mow-agent, le démon de chaque ordinateur (bureau, entrées, shell)
apps/web              App web (Vite + React + TanStack)
packages/contract     Schémas zod partagés (source de vérité des types de l'API)
packages/api-client   Client TypeScript généré depuis l'OpenAPI (web, futures apps mobile/desktop)
packages/design       Tokens (noir et blanc) et génome des personnages, partagés avec les futures apps
workstation/          Image Docker des ordinateurs (Ubuntu, XFCE, VNC, Chrome, mow-agent)
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

### Ordinateurs en local

Le compte, l'API et les fichiers marchent sans Docker. Pour allumer le PC d'une équipe, il faut Docker (Docker Desktop sous Windows/macOS) et l'image des ordinateurs, à construire une fois depuis la racine du dépôt :

```bash
docker build -f workstation/Dockerfile -t mowbot/workstation:local .
```

Le hub publie l'agent de chaque ordinateur sur `127.0.0.1` et monte le workspace de l'équipe (`apps/hub/.data/workspaces/<id>`) sur `/workspace`. Après une reconstruction de l'image, chaque PC est recréé à son prochain démarrage ; son dossier `/home/bot` est conservé.

### Réveiller le Chef

Dans l'app, **Modèles → Ajouter** : Command Code (clé de ton abonnement), OpenAI (clé API) ou n'importe quel fournisseur compatible OpenAI (OpenRouter, Ollama…). Le premier fournisseur ajouté est donné au Chef ; le modèle se choisit par bot. Pour les captures d'écran, prends un modèle qui accepte les images.

### Depuis le réseau local

`pnpm dev` écoute sur toutes les interfaces : depuis un téléphone ou un autre PC du LAN, ouvre `http://<ip-de-cette-machine>:5173` (Vite affiche les adresses au démarrage). Sous Windows, autorise Node.js dans le pare-feu si une fenêtre le demande.

### Personnages des bots

Chaque bot a son personnage, tiré de sa graine (`packages/design`) : couleur, forme, yeux, rythme de clignement. En dev, la galerie `/dev/avatars` montre les variantes et les humeurs.

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

Remplis `deploy/.env` (domaine, mot de passe Postgres, clé maître), puis construis les images (y compris celle des ordinateurs) et démarre :

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile build build
```

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Caddy sert le web et l'API en HTTPS (certificat automatique pour un domaine public). Pour le réseau local, mets l'IP ou le nom LAN du serveur dans `MOWBOT_DOMAIN` (voir `deploy/.env.example` : HTTPS avec l'autorité interne de Caddy, ou HTTP simple). Récupère le jeton de configuration avec :

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs hub
```

**Sauvegarde `MOWBOT_MASTER_KEY`** : sans elle, les secrets chiffrés sont illisibles.
