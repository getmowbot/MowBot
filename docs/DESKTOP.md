# App desktop et projets locaux

L'app desktop (Tauri) affiche l'interface du hub, comme le navigateur, et embarque un **connecteur**
écrit en Rust. Le connecteur ouvre une connexion sortante vers le hub (qui peut être sur un serveur
distant) : les bots lisent, écrivent, cherchent et lancent des commandes dans les dossiers que
l'utilisateur a partagés depuis son ordinateur, les **projets**.

## Confiance

- Seul l'utilisateur, depuis l'app desktop, partage un dossier. Le hub ne peut ni ajouter un
  dossier ni sortir d'un dossier partagé : le connecteur résout chaque chemin (liens symboliques
  compris) et refuse tout ce qui sort de la racine du projet.
- Lire et écrire des fichiers : libre. Lancer une commande : avec l'accord de l'utilisateur
  (question Autoriser / Tout autoriser dans ce projet / Refuser), sauf en mode **auto** du projet.
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
```

`key` est un identifiant stable choisi par le connecteur (UUID) ; `os` : `windows` | `macos` |
`linux` ; `shell` : celui qui exécute `exec` (`powershell` sous Windows, `bash`/`zsh`/`sh`
ailleurs).

### Hub → connecteur

```jsonc
{ "t": "req", "id": "42", "op": "read", "project": "b6c1…", "args": { "path": "src/main.rs" } }
```

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

### Copie sur le PC d'un bot, retour en branche git

| op | args | data |
|---|---|---|
| `manifest` | `path?` (dossier, défaut : tout le projet) | `{ files: [{ path, size, hash }], head, truncated }` |
| `read_files` | `paths` (au plus 200) | `{ files: [{ path, data }] }` ; `data` en base64 |
| `branch` | `name`, `message`, `author`, `base`, `files: [{ path, data }]`, `deletes` | `{ branch, commit }` |

- `manifest` liste les fichiers comme `find` (`.gitignore` respecté, `.git` sauté, liens non
  suivis), avec `hash` = SHA-256 en hexadécimal du contenu. Fichiers de plus de 20 Mo et listes de
  plus de 50 000 fichiers : laissés de côté (`truncated`). `head` : le commit `HEAD` si le projet est
  dans un dépôt git (`git rev-parse HEAD`), sinon `null`.
- `read_files` renvoie le contenu de chaque fichier demandé ; le hub demande par lots (8 Mo au plus
  par réponse). Un fichier qui manque ou sort du projet fait échouer la requête.
- `branch` crée la branche `name` dans le dépôt du projet **sans toucher à son dossier de travail ni
  à son index** : index temporaire (`GIT_INDEX_FILE`) chargé depuis `base` (`git read-tree`), fichiers
  écrits avec `git hash-object -w` + `git update-index --cacheinfo` (mode d'origine gardé, sinon
  100644), suppressions avec `git update-index --force-remove`, puis `git write-tree`,
  `git commit-tree -p base` (auteur et committer : `author` = `{ name, email }`), et
  `git update-ref refs/heads/<name> <commit> ""` (refuse d'écraser ; le hub choisit un nom libre).
  Les chemins sont relatifs au projet : si le projet est un sous-dossier du dépôt, le préfixe
  (`git rev-parse --show-prefix`) leur est ajouté. Pas de dépôt git ou pas de `git` : erreur lisible.

## Côté hub

- Tables `connectors` (jeton haché, nom, OS, shell, dernière connexion) et `projects` (connecteur,
  `key`, nom, chemin affiché, mode `ask` | `auto`, portée : tous les bots, des équipes, des bots).
- Outils des bots : `local_projects`, `local_list`, `local_read`, `local_write`, `local_edit`,
  `local_find`, `local_search`, `local_exec` (paramètre `project` : nom du projet ; sans lui, le
  projet actif du bot, ou le seul projet qu'il a).
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
- `local_pull` copie le projet (ou un dossier) dans le workspace de l'équipe du bot,
  `/workspace/projects/<projet>/`, pour qu'il le lance et le teste sur son PC : seuls les fichiers
  changés depuis la dernière copie sont transférés, ceux disparus sont retirés. L'état copié est
  gardé dans `.mowbot-sync.json` (hash de chaque fichier et commit de départ).
- `local_push` rapporte les changements de cette copie (fichiers modifiés, ajoutés hors
  `.gitignore`, supprimés) en une branche `mowbot/<bot>-<date>` du dépôt de l'utilisateur, partie du
  commit de la copie : rien ne change dans son dossier, il relit et fusionne quand il veut.

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

Puis, dans Réglages → Projets : **Relier ce PC**, et **Partager un dossier**.

La fenêtre n'a pas de barre de titre système : l'interface affiche ses boutons (réduire, agrandir,
fermer) et le haut de la fenêtre la déplace (double-clic : agrandir). La fermer la garde dans la
barre des tâches, où le connecteur continue de servir les bots.

En développement :

```bash
pnpm --filter @mowbot/desktop start    # tauri dev
pnpm --filter @mowbot/desktop bundle   # installeur de cette machine (tauri build)
```

## Plus tard

- Copier un projet (ou un dossier) sur le PC d'un bot, en respectant `.gitignore`, et rapporter
  ses changements sous forme de branche git ou de diff à valider.
- Partager les serveurs MCP de l'ordinateur de l'utilisateur.
