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

## Côté hub

- Tables `connectors` (jeton haché, nom, OS, shell, dernière connexion) et `projects` (connecteur,
  `key`, nom, chemin affiché, mode `ask` | `auto`, portée : tous les bots, des équipes, des bots).
- Outils des bots : `local_projects`, `local_list`, `local_read`, `local_write`, `local_edit`,
  `local_find`, `local_search`, `local_exec` (paramètre `project` : nom du projet).
- Une commande en mode `ask` pose la question à l'utilisateur et répond au bot que la décision
  arrivera en message ; « Autoriser » vaut pour cette commande une fois, « Tout autoriser dans ce
  projet » passe le projet en `auto`.

## Installer et lancer l'app

- **Windows, macOS** : les installeurs (`.exe` / `.msi`, `.dmg`) sont fabriqués par le workflow
  « Desktop app » (tag `desktop-v0.1.0`, ou lancement à la main) dans une release brouillon GitHub.
- **Linux**, en une commande (AppImage dans `~/.local/bin`, entrée dans les applications) :

  ```bash
  curl -fsSL https://raw.githubusercontent.com/jorisleva/MowBot/main/apps/desktop/install-linux.sh | sh -s -- --hub https://mowbot.example.com
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
