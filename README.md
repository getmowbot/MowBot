# MowBot

Des équipes de bots IA self-hosted. Chaque équipe partage un vrai PC Linux (bureau, navigateur, `sudo`) et un workspace de fichiers ; un bot **Chef** crée les équipes, distribue les missions et coordonne. Les bots sont proactifs, se parlent, se partagent leurs accès et utilisent des serveurs MCP.

- Spécification : [docs/SPEC.md](docs/SPEC.md)
- Roadmap : [docs/ROADMAP.md](docs/ROADMAP.md)

> **État : P6, et l'app desktop.**
> - L'app desktop (Tauri) : les équipes travaillent sur les projets de ton ordinateur, comme un assistant de code, même si le hub est sur un serveur. Tu partages un dossier, les bots y lisent, modifient, cherchent et lancent des commandes (avec ton accord, ou librement en mode auto). Voir [docs/DESKTOP.md](docs/DESKTOP.md).
> - Dans le chat, `@` cite un bot, une équipe ou un fichier du workspace (le bot reçoit qui c'est, ou le contenu du fichier), `/` lance une commande : `/stop`, `/clear`, `/pc`, `/files`, `/mcp`…
> - Les bots utilisent des serveurs MCP : distants (URL, clé ou connexion OAuth depuis l'app) ou locaux, lancés sur le PC d'un bot. Tu choisis qui y a droit (tous, des équipes, des bots) ; un bot peut aussi s'installer lui-même un serveur sur son PC.
> - Les bots confient au hub de petits scripts qui tournent tout seuls sur leur PC (score en direct, surveillance de prix) : la carte se met à jour, tu es prévenu, sans réveiller l'IA. Notifications push sur iPhone (fin de travail, besoin de toi).
> - Dans la conversation, les bots montrent plutôt que décrire : cartes (produit, lieu, itinéraire, avec des boutons qui ouvrent la page sur ton téléphone ou leur répondent), images, chiffres. Ils te demandent un mot de passe par un formulaire masqué qui va droit au coffre. Un message envoyé pendant qu'ils travaillent est pris en compte tout de suite, et un bot peut en arrêter un autre.
> - Le coffre : quand tu te connectes à un site sur le PC d'un bot, la session est gardée et les bots des autres PC s'en servent ; identifiants et clés s'utilisent sans jamais être montrés aux modèles.
> - Les bots agissent d'eux-mêmes : routines (cron, intervalle, webhook), réveils périodiques, notifications et bilan du soir, budgets et pause globale.
> - Ils épinglent leurs résultats sur la page d'accueil (score, liste de courses, chiffres…) et te posent leurs questions avec des réponses en boutons.
> - Chaque bot navigue dans sa propre fenêtre de Chrome, sans prendre l'écran, et tu la vois en direct.
> - Les équipes de bots se parlent, se confient des tâches et s'échangent des fichiers, sur des PC Linux partagés.
> - L'API est sécurisée ; l'interface est en français et en anglais.
>
> Prochaine étape : copier un projet sur le PC d'un bot et rapporter ses changements en branche git ou en diff.

## Structure

```
apps/hub              API Fastify : auth, appareils, équipes, ordinateurs (Docker), fichiers, événements
apps/agent            mow-agent, le démon de chaque ordinateur (bureau, entrées, shell)
apps/desktop          App desktop (Tauri) : l'interface du hub et le connecteur Rust des projets locaux
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

### App mobile (Expo Go)

L'app iOS / Android (`apps/mobile`, Expo SDK 57) se lance dans **Expo Go** :

```bash
pnpm --filter @mowbot/mobile start
```

Scanne le QR code avec Expo Go (même réseau local), puis connecte-toi avec l'adresse du hub (`http://<ip-de-cette-machine>:8787`) et ton mot de passe. Sous Windows, autorise Node.js dans le pare-feu (Metro écoute sur le port 8081).

L'app fait tout ce que fait le site :
- l'accueil : canvas, questions des bots, notifications, pause ;
- les conversations : options du bot dans ⋯ ;
- le PC de chaque bot : écran en direct, prise de contrôle avec clavier, fenêtre de chaque bot ;
- la gestion des équipes et des bots ;
- les modèles, les routines et la proactivité ;
- les appareils ;
- les fichiers.

L'écran du PC charge noVNC depuis un CDN : le téléphone a besoin d'un accès à internet.

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

Sur un serveur Linux (Ubuntu, Debian, Fedora…), une seule commande installe tout, et la même met à jour :

```bash
git clone git@github.com:jorisleva/MowBot.git && sudo MowBot/install.sh
```

Le dépôt est privé : le serveur clone avec une clé SSH ajoutée à ton compte GitHub. Une fois le dépôt public, ceci suffira :

```bash
curl -fsSL https://raw.githubusercontent.com/jorisleva/MowBot/main/install.sh | sudo bash
```

Le script :
- installe Docker s'il manque (script officiel `get.docker.com`) ;
- demande l'adresse : un nom de domaine public, servi en HTTPS avec un certificat automatique, ou rien pour le réseau local en HTTP ;
- écrit `deploy/.env` avec des clés générées ;
- construit les images (le hub, le web, le PC des bots), puis démarre. La première fois prend 10 à 20 minutes ;
- affiche l'adresse et le jeton de configuration pour créer ton compte.

Il installe aussi la commande `mowbot` :

| Commande | Rôle |
|---|---|
| `sudo mowbot update` | Récupère le code, reconstruit les images et redémarre. Tes réglages et tes données restent. |
| `sudo mowbot status` | État des services et adresse |
| `sudo mowbot logs [hub]` | Journaux en direct |
| `sudo mowbot stop` / `start` / `restart` | Arrêter (PC des bots compris), relancer |

Relancer `install.sh` fait la même chose que `mowbot update`. Les PC des bots passent à la nouvelle image à leur prochain démarrage.

Options sans question : `--domain mowbot.example.com`, `--lan`, `--port 8080` (port HTTP en réseau local), `--yes`. Pour un autre emplacement que `/opt/mowbot` avec la version `curl` : `--dir`.

**Sauvegarde `deploy/.env`** : sa clé `MOWBOT_MASTER_KEY` chiffre les secrets ; sans elle, ils sont illisibles.

### À la main

Avec Docker déjà installé :

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
