# App desktop et projets locaux

L'app desktop (Tauri) affiche l'interface du hub, comme le navigateur, et embarque un **connecteur**
écrit en Rust. Le connecteur ouvre une connexion sortante vers le hub (qui peut être sur un serveur
distant) : les dossiers que l'utilisateur a partagés depuis son ordinateur, les **projets**, ont un
**miroir** dans le workspace des bots, synchronisé dans les deux sens, où ils travaillent même
quand l'ordinateur est éteint ; les commandes peuvent se lancer sur l'ordinateur.

## Confiance

- Seul l'utilisateur, depuis l'app desktop, partage un dossier : le hub peut lui demander
  d'ouvrir son sélecteur (`pick`), mais c'est lui qui choisit le dossier, sur cet ordinateur. Le
  hub ne peut pas sortir d'un dossier partagé : le connecteur résout chaque chemin (liens
  symboliques compris) et refuse tout ce qui sort de la racine du projet, et n'écrit jamais dans
  `.git`.
- Lire et écrire des fichiers : libre (une suppression va à la corbeille du système). Lancer une
  commande : avec l'accord de l'utilisateur (question Autoriser / Tout autoriser dans ce projet /
  Refuser), sauf en mode **auto** du projet.
- Le jeton du connecteur ne sert qu'à cette connexion ; il se révoque en supprimant le connecteur
  (page Projets).

## Connexion

`GET /api/v1/connectors/ws` en WebSocket, en-tête `Authorization: Bearer <jeton du connecteur>`.
Le jeton est donné une fois, à la création du connecteur (`POST /api/v1/connectors`). Chaque
message est un objet JSON (texte). Le hub ping toutes les 25 s.

### Connecteur → hub

```jsonc
// Dès la connexion, puis à chaque changement des dossiers partagés (même forme, t: "projects").
{ "t": "hello", "version": "0.1.0", "hostname": "PC-de-Joris", "os": "windows", "shell": "powershell",
  "projects": [{ "key": "b6c1…", "name": "MowBot", "path": "C:\\Users\\Joris\\projects\\MowBot" }] }
{ "t": "projects", "projects": [ … ] }

// Réponse à une requête : data selon l'opération, ou une erreur lisible.
{ "t": "res", "id": "42", "ok": true, "data": { … } }
{ "t": "res", "id": "42", "ok": false, "error": "Fichier introuvable : src/x.ts" }

// 0.2.5 : des fichiers ont changé dans un projet surveillé (null : n'importe lesquels).
{ "t": "changed", "project": "b6c1…", "paths": ["src/app.ts", "README.md"] }
```

`key` est un identifiant stable choisi par le connecteur (UUID) ; `os` : `windows` | `macos` |
`linux` ; `shell` : celui qui exécute `exec` (`powershell` sous Windows, `bash`/`zsh`/`sh`
ailleurs).

`changed` (0.2.5) : l'app surveille les projets que le hub lui demande (`watch`, plus bas), le
temps de la connexion. Elle attend 700 ms sans nouveau changement (3 s au plus quand ça n'arrête
pas) puis envoie un message par projet, chemins relatifs dédoublonnés ; au-delà de 200 chemins,
ou quand des événements ont été perdus, `paths` vaut `null`. Ne sont pas envoyés : `.git`, les
noms de `exclude`, les fichiers temporaires de `put`, et ce que le hub vient d'écrire ou de
supprimer lui-même (3 s).

### Hub → connecteur

```jsonc
{ "t": "req", "id": "42", "op": "read", "project": "b6c1…", "args": { "path": "src/main.rs" } }

// 0.2.5 : les projets à surveiller (ceux qui ont un miroir), remplacés à chaque message.
{ "t": "watch", "projects": ["b6c1…"], "exclude": ["node_modules", ".venv", "target", …] }

// 0.2.5 : ouvrir le sélecteur de dossier sur cet ordinateur (demandé depuis un autre appareil).
// Réponse : { t: "res", id, ok: true, data: { key, name, path } | null } (null : annulé).
{ "t": "pick", "id": "43" }
```

`pick` affiche la fenêtre de l'app et le sélecteur natif ; seul le dossier que l'utilisateur
choisit, sur cet ordinateur, est partagé (déjà partagé : ce projet ; sinon un nouveau, nommé
d'après le dossier, `Site 2` si `Site` existe), annoncé (`projects`) avant la réponse.

Les chemins sont relatifs à la racine du projet, avec des `/` ; `""` est la racine.

| op | args | data |
|---|---|---|
| `list` | `path` | `{ entries: [{ name, path, type: "file"\|"directory", size }] }` (dossiers d'abord) |
| `read` | `path`, `offset?` (ligne, 1 = première), `limit?` (lignes, défaut 2000) | `{ text, totalLines, truncated }` ; un fichier binaire est refusé |
| `write` | `path`, `content` (texte) | `{ size }` ; crée les dossiers manquants |
| `edit` | `path`, `old`, `new`, `all?` | `{ replaced }` ; `old` doit être unique sauf `all` |
| `find` | `pattern` (glob, ex. `src/**/*.ts`), `limit?` | `{ paths, truncated }` |
| `search` | `pattern` (regex), `path?`, `glob?`, `limit?` (défaut 100) | `{ matches: [{ path, line, text }], truncated }` |
| `exec` | `command`, `cwd?`, `timeoutMs?` (défaut 120 000, max 600 000) | `{ exitCode, stdout, stderr, timedOut }` (sorties gardées sur 200 Ko) |

`find` et `search` respectent `.gitignore` et sautent `.git`. `exec` lance la commande avec le
shell annoncé, dans la racine du projet (ou `cwd`).

### Le miroir dans le workspace des bots

| op | args | data |
|---|---|---|
| `manifest` | `path?` (dossier, défaut : tout le projet) ; 0.2.5 : `rules?`, `exclude?`, `paths?` | `{ files: [{ path, size, hash, exec? }], skipped, head, truncated, complete }` |
| `read_files` | `paths` (au plus 200) | `{ files: [{ path, data }] }` ; `data` en base64 |
| `put` (0.2.5) | `files: [{ path, data, expect?, exec? }]` (au plus 500) | `{ results: [{ path, ok, size? \| changed?, current? \| error? }] }` |
| `delete` (0.2.5) | `files: [{ path, expect? }]` (au plus 500) | `{ results: [{ path, ok, trashed?, gone? \| changed?, current? \| error? }] }` |
| `branch` | `name`, `message`, `author`, `base`, `files`, `deletes` | `{ branch, commit }` ; gardé pour les hubs d'avant le miroir |

- `manifest` liste les fichiers comme `find` (`.gitignore` respecté, `.git` sauté, liens non
  suivis), avec `hash` = SHA-256 en hexadécimal du contenu (gardé en mémoire tant que la taille et
  la date de modification du fichier ne changent pas). Fichiers de plus de 20 Mo et listes de plus
  de 50 000 fichiers : laissés de côté (`truncated`) ; depuis 0.2.5, `skipped` nomme les fichiers
  laissés de côté et `complete` dit que tout a été vu (un fichier ni listé ni dans `skipped`
  n'existe pas). `head` : le commit `HEAD` si le projet est dans un dépôt git, sinon `null`.
  Pour un miroir (0.2.5) : `rules: "project"` ne suit que les `.gitignore` du projet (ni ceux des
  dossiers parents, ni l'exclusion globale de git, ni `.git/info/exclude`, ni `.ignore`), comme le
  hub de son côté ; `exclude` : des noms sautés à toute profondeur ; `paths` : seulement ces chemins
  (fichiers, ou dossiers et leur contenu ; `head` vaut alors `null`). `exec` : fichier exécutable
  (Unix).
- `read_files` renvoie le contenu de chaque fichier demandé ; le hub demande par lots (8 Mo au plus
  par réponse). Un fichier qui manque ou sort du projet fait échouer la requête.
- `put` écrit chaque fichier (base64) en place : fichier temporaire `.<nom>.mowbot-tmp` à côté, puis
  renommé par-dessus (un éditeur ou un build ne lit jamais un fichier à moitié écrit ; permissions
  gardées, `exec` pour un nouveau fichier exécutable). `delete` met le fichier à la corbeille du
  système (supprimé pour de bon si la corbeille refuse) et retire les dossiers devenus vides.
  `expect` : le hash que le hub a vu en dernier (`null` : pas de fichier) ; si le fichier a changé
  depuis, il n'est pas touché (`changed: true`, `current` : son hash). Rien dans un dossier `.git`.

### Comment se comporte le miroir

Chaque projet où des bots travaillent a un **miroir** dans leur workspace (celui de l'équipe, ou du
bot solo) : `/workspace/projects/<nom>` (`<nom>-2`… si deux projets ont le même nom), tenu à jour
par le hub dans les deux sens. Les bots y travaillent avec leurs outils habituels (`bash`,
`read_file`, `write_file`).

- **Ce qui est synchronisé** : ce que git garderait. Les `.gitignore` du projet sont suivis, et
  ces noms ne le sont jamais, à aucune profondeur : `.git`, `node_modules`, `.venv`, `venv`,
  `__pycache__`, `.mypy_cache`, `.pytest_cache`, `target`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`,
  `.cache`, `.parcel-cache`, `.gradle`, `.dart_tool`, `.expo`, `.DS_Store`, `Thumbs.db`. Chaque côté
  installe ses dépendances. Les fichiers de plus de 20 Mo restent où ils sont, des deux côtés.
- **Réconciliation à trois** : le hub garde, pour chaque miroir, le hash de chaque fichier tel que
  les deux côtés l'avaient la dernière fois qu'ils étaient d'accord
  (`.mowbot/mirrors/<id>.json` dans le workspace). Un fichier changé d'un seul côté passe de
  l'autre ; supprimé d'un côté et inchangé de l'autre, il y est supprimé aussi ; changé d'un côté
  et supprimé de l'autre, le changement gagne (le fichier revient). Les suppressions partent avant
  les écritures (un renommage sur un disque qui ignore la casse).
- **Conflits** (les deux côtés ont changé le même fichier) : la version de l'utilisateur reste en
  place, dans son dossier et dans le miroir ; celle des bots est gardée dans le workspace, hors du
  miroir, `projects/_conflicts/<nom>/<date-heure>/<chemin>`. L'utilisateur reçoit une notification,
  les bots qui travaillent dans le miroir une note dans leur conversation. Les conflits restent
  listés (projet → `mirrors[].conflicts`) jusqu'à ce que l'utilisateur les écarte
  (`POST /projects/:id/conflicts/dismiss`, la version des bots va à la corbeille du workspace).
- **Quand** : à la connexion de l'app (tout est revu, sans qu'un bot fasse rien), sur ses
  `changed` (seulement les chemins indiqués), quand le workspace change (`workspace.changed` :
  un bot a écrit, l'utilisateur a déposé un fichier), et toutes les 2 minutes en entier (toutes
  les 45 s pour une app sans `watch`). Des demandes rapprochées font une seule passe.
- **Ordinateur hors ligne** : les bots continuent dans le miroir ; le projet affiche le nombre de
  changements en attente. À la reconnexion, tout est réconcilié.
- **Git** : le miroir est le dossier de travail, sans `.git`. Le dossier de l'utilisateur est mis à
  jour en place (plus de branche) : ses changements sont visibles dans `git status`. Pour
  l'historique (log, diff, commit), les bots passent par `local_exec`.
- **Garde-fous** : une écriture ou une suppression chez l'utilisateur dit ce qu'elle s'attend à
  trouver (`expect`) ; plus de la moitié du projet (et plus de 20 fichiers) supprimée d'un coup
  dans le miroir y est remise depuis l'ordinateur au lieu d'être supprimée chez lui ; un miroir
  disparu en entier (`rm -rf`) est recopié ; un dossier déjà là à la création du miroir (une
  ancienne copie de `local_pull`) va à la corbeille du workspace.
- **Taille** : au-delà de `MOWBOT_MIRROR_MAX_MB` (500 Mo) ou `MOWBOT_MIRROR_MAX_FILES` (20 000
  fichiers), pas de miroir (`too_big`, avec le message) : les bots travaillent alors directement
  sur l'ordinateur. Le miroir se désactive aussi par projet (page Projets, `mirror: false`) : ses
  copies vont à la corbeille de leur workspace.
- **Apps plus anciennes** : sans `watch`, l'ordinateur est revu en entier ; les écritures passent
  par `write` (texte, et binaires en base64 depuis 0.2.4) ; les suppressions (et avant 0.2.4 les
  binaires) attendent 0.2.5, et le miroir le dit (`pending`, avec la raison).

## Côté hub

- Tables `connectors` (jeton haché, nom, OS, shell, version, dernière connexion), `projects`
  (connecteur, `key`, nom, chemin affiché, mode `ask` | `auto`, portée : tous les bots, des équipes,
  des bots ; `mirror`) et `project_mirrors` (projet, workspace, dossier, état : `waiting`,
  `syncing`, `synced`, `pending`, `too_big`, `error` ; changements en attente, conflits, dernière
  synchro), exposés avec chaque projet (`mirrors`).
- Outils des bots (paramètre `project` : nom du projet ; sans lui, le projet actif du bot, ou le
  seul projet qu'il a) : `local_projects`, `local_use_project`, `local_sync` (synchronise le miroir
  tout de suite et dit où il en est ; crée le miroir d'un projet qui n'en a pas encore),
  `local_exec` (sur l'ordinateur quand il est en ligne : le miroir est synchronisé avant et après la
  commande ; hors ligne, le bot est renvoyé vers son PC, dans le miroir). Pour un projet sans
  miroir (désactivé ou trop gros) : `local_list`, `local_read`, `local_write`, `local_edit`,
  `local_find`, `local_search`, directement sur l'ordinateur. Le prompt dit où est le miroir, où il
  en est, et si l'ordinateur est en ligne.
- **Ajouter un dossier depuis la conversation** : la puce du projet propose « Ajouter un
  dossier… ». Dans l'app desktop, son sélecteur s'ouvre, le dossier est partagé (le PC relié
  d'abord s'il ne l'est pas) et devient le projet actif du bot. Ailleurs (navigateur, mobile),
  l'app explique qu'un dossier s'ajoute depuis l'app desktop de l'ordinateur, et peut demander à
  une app connectée (0.2.5) d'ouvrir son sélecteur : `POST /connectors/:id/pick` (`botId` : le bot
  dont il devient le projet actif ; attend 5 minutes au plus, `project: null` si l'utilisateur
  annule ; 409 `app_update_needed` pour une app plus ancienne, `connector_offline` hors ligne).
- **Projet actif** : chaque bot a un projet où il travaille (`bots.project_id`, `projectId` du bot),
  choisi dans la conversation : puce au-dessus du champ de message (web, desktop, mobile), commande
  `/project` (`/projet`), ou le bot lui-même avec `local_use_project` (« je bosse sur X »).
  `PUT /bots/:id/project` n'accepte qu'un projet que le bot peut utiliser ; un ordinateur hors
  ligne reste choisissable. Le changement part en `bot.updated` (tous les appareils suivent) et
  ajoute à la conversation une note silencieuse (« 📁 Projet actif : X ») que le bot lit, même au
  milieu d'une réponse ; changé à nouveau avant qu'il l'ait lue, la note est remplacée. Le prompt
  système nomme le projet actif et dit si son ordinateur est en ligne. Un projet qui n'est plus
  partagé n'est plus actif. `@Projet` dans un message décrit le projet au bot.
- Une commande en mode `ask` pose la question à l'utilisateur et répond au bot que la décision
  arrivera en message ; « Autoriser » vaut pour cette commande une fois, « Tout autoriser dans ce
  projet » passe le projet en `auto`.
- Le miroir naît quand un bot qui a un workspace prend le projet comme projet actif (choix de
  l'utilisateur, `local_use_project`, une tâche confiée dans le projet) ou le synchronise
  (`local_sync`), puis vit tant que le projet est partagé et mis en miroir. `local_pull` et
  `local_push` (copie, puis retour en branche git) n'existent plus.

## Se connecter avec ChatGPT

Le fournisseur **OpenAI (compte ChatGPT)** fait tourner les bots sur le forfait ChatGPT de
l'utilisateur (Plus, Pro…), sans clé API : c'est le programme « Sign in with ChatGPT » d'OpenAI
pour les clients open source (developers.openai.com/siwc).

- OpenAI renvoie le navigateur vers une adresse locale (`http://127.0.0.1:<port>/auth/callback`),
  qui n'atteint que l'ordinateur du navigateur : la connexion se fait dans l'app desktop
  (Réglages → Modèles → Ajouter → OpenAI (compte ChatGPT) → **Se connecter avec ChatGPT**), même
  quand le hub est sur un serveur. Dans un navigateur ou sur mobile, la page renvoie vers l'app.
- La page du hub demande au hub son `ext_agent_host_id` (`GET /api/v1/providers/chatgpt/sign-in`),
  puis appelle la commande `chatgpt_sign_in` de l'app : écoute sur `127.0.0.1:1455` (un autre port
  libre s'il est pris), PKCE S256, `state` et `nonce` neufs, navigateur du système sur
  `https://auth.openai.com/api/accounts/authorize` (`client_id=dynamic_agent_client` et
  `agent_name_hint=MowBot` la première fois ; ensuite le client émis, `oaiapp_…`, et l'e-mail en
  `login_hint`). Au retour : `state` vérifié (une autre page reçoit « Lien expiré »), client émis
  exigé, code échangé sur `/api/accounts/oauth/token` (même `redirect_uri`, même `resource`), scope
  `chatgpt.tokens.use.direct` et `nonce` du jeton d'identité vérifiés. Cinq minutes pour revenir ;
  **Annuler** (`chatgpt_sign_in_cancel`) ou une nouvelle connexion arrête l'attente. Le navigateur
  affiche une courte page de fin.
- L'app ne garde rien : les jetons passent à la page du hub, qui les envoie une fois au hub
  (`chatgpt` de `POST /api/v1/providers`, ou de `PATCH` pour se reconnecter) avec la session de
  l'utilisateur. Le hub vérifie le jeton d'identité (signature avec les clés publiées par OpenAI,
  émetteur, audience = client émis, expiration, nonce ; même compte pour une reconnexion), chiffre
  les jetons comme les autres secrets et ne les renvoie jamais : l'API ne montre que l'e-mail, le
  forfait et l'état (`connected`, `needs_sign_in`, `usage_limited`).
- **L'hôte, c'est le hub**, qui utilise les jetons (comme la VM de « Self-hosted VMs » dans la doc
  d'OpenAI) : son `ext_agent_host_id` (`urn:uuid:…`) est créé une fois par installation du hub
  (table `settings`), quel que soit l'ordinateur qui fait la connexion.
- Le hub renouvelle seul le jeton d'accès (une heure) cinq minutes avant son expiration et sur un
  401, un renouvellement à la fois par fournisseur, et enregistre le nouveau jeton de
  renouvellement en même temps. Si OpenAI refuse le renouvellement, il oublie les jetons (garde le
  compte et le client) et le fournisseur passe « Déconnecté » : **Se reconnecter** dans l'app
  desktop. Supprimer le fournisseur révoque son jeton de renouvellement.
- Les bots passent par l'API Responses avec `store: false` et `stream: true`, sans les paramètres
  que le forfait refuse. À la limite d'utilisation (`subscription_sharing_usage_limit_exceeded`),
  le bot passe à son modèle de secours avec un message clair, le fournisseur est laissé de côté
  cinq minutes et affiche « Limite d'utilisation atteinte » avec un lien vers
  https://chatgpt.com/settings/usage.

## Installer et lancer l'app

- **Windows, macOS** : les installeurs (`.exe` / `.msi`, `.dmg`) sont dans les releases GitHub
  `desktop-v<version>`. Le workflow « Desktop app » les fabrique et les publie à chaque fusion dans
  main qui touche l'app (ou sur un tag `desktop-v*`, ou à la main). Changer `version` dans
  `apps/desktop/src-tauri/tauri.conf.json` crée une nouvelle release ; sinon ses installeurs sont
  remplacés.
- **Linux**, en une commande (AppImage dans `~/.local/bin`, entrée dans les applications) :

  ```bash
  curl -fsSL https://raw.githubusercontent.com/getmowbot/MowBot/main/apps/desktop/install-linux.sh | sh -s -- --hub https://mowbot.example.com
  ```

  Tant que le dépôt est privé, il faut un `GITHUB_TOKEN` qui peut le lire (dans l'environnement).

**L'adresse du hub** (celle de l'interface web, par exemple `http://localhost:5173` ou
`https://mowbot.example.com`) est demandée au premier lancement ; ensuite **Profil → Changer de
hub**, ou l'icône de la barre des tâches → Changer de hub. `mowbot-desktop --hub <adresse>`
l'enregistre directement (c'est ce que fait la commande Linux) ; `MOWBOT_HUB_URL` l'impose sans
l'enregistrer (développement).

Puis, dans Réglages → Projets : **Relier ce PC**, et **Partager un dossier** ; ou, dans une
conversation, la puce du projet → **Ajouter un dossier…** (le PC est relié au passage).

La fenêtre n'a pas de barre de titre système : l'interface affiche ses boutons (réduire, agrandir,
fermer) et le haut de la fenêtre la déplace (double-clic : agrandir). La fermer la garde dans la
barre des tâches, où le connecteur continue de servir les bots.

En développement :

```bash
pnpm --filter @mowbot/desktop start    # tauri dev
pnpm --filter @mowbot/desktop bundle   # installeur de cette machine (tauri build)
```

## Plus tard

- Partager les serveurs MCP de l'ordinateur de l'utilisateur.
- Retirer un miroir dont plus aucun bot de son workspace ne se sert depuis longtemps.
