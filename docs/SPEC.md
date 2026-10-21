# MowBot — Spécification

> Version 0.1 — 2026-10-20. Document vivant : toute décision d'architecture qui change doit être reportée ici.

## 0. Vision

MowBot est une plateforme **self-hosted** qui transforme un ou plusieurs LLM en **équipes de bots IA** autonomes.

- Plusieurs **équipes** de bots, plus des **bots solo** hors équipe.
- Les bots d'une équipe travaillent **ensemble, en même temps, sur le PC Linux partagé de l'équipe** (conteneur Docker avec bureau graphique, navigateur et `sudo`) et dans le **workspace de fichiers de l'équipe**.
- Option par bot : **PC dédié**.
- Un bot **Chef** est le point d'entrée : il crée des équipes et des bots, leur donne des missions et coordonne.
- Les bots sont **proactifs** : ils créent eux-mêmes des routines (planifiées ou sur événement) quand c'est pertinent.
- Les bots se parlent, se délèguent du travail et se partagent des accès (sessions navigateur, secrets).
- L'utilisateur peut **prendre le contrôle** d'un bureau depuis le chat (connexion à un compte, 2FA, captcha…).
- Les bots utilisent des serveurs **MCP**.
- **API sécurisée d'abord** : le web est le premier client ; iOS, Android et Desktop suivront sur la même API.

Référence d'inspiration : Grok Bot (xAI). Différences : self-hosted, modèles au choix, plusieurs équipes, PC dédiés possibles, workspaces navigables.

### Hypothèses de départ

| Sujet | Décision |
|---|---|
| Hébergement | Serveur Linux 24/7 (dev possible en local Windows + Docker Desktop) |
| Utilisateurs | Mono-utilisateur (owner), multi-appareils |
| Clients | Web d'abord ; Expo (iOS/Android) et Tauri (desktop) plus tard |
| Providers v1 | OpenAI-compatible générique, Command Code, OpenAI (clé API ou abonnement ChatGPT) |
| Langage | TypeScript partout |

---

## 1. Concepts

| Concept | Définition |
|---|---|
| **Hub** | Serveur central : API, orchestrateur, cerveau des bots (boucle agent), scheduler, coffre, passerelle MCP. |
| **Bot** | Agent IA persistant : nom, avatar, rôle/domaine, mission, modèle, mémoire, routines, niveau d'autonomie, budget. |
| **Chef** | Bot racine créé au setup, non supprimable, lead de l'« Équipe principale ». Point d'entrée par défaut. Crée équipes et bots (en équipe ou solo), nomme les leads, coordonne entre équipes. |
| **Équipe** | Groupe de bots avec : un **lead** (optionnel), un **PC d'équipe** partagé, un **workspace**, un canal, une base de connaissances, une mémoire d'équipe et ses politiques. |
| **Bot solo** | Bot hors équipe (`team_id = null`) : PC dédié + workspace personnel. |
| **Ordinateur** | Conteneur Docker persistant (Ubuntu + XFCE + VNC + Chrome + sudo + daemon `mow-agent`). **PC d'équipe** (partagé) ou **PC dédié** (un seul bot). Un bot est rattaché à exactement un ordinateur. |
| **Workspace** | Arborescence de fichiers d'une équipe (ou d'un bot solo), montée sur `/workspace` dans ses ordinateurs, navigable et téléchargeable par l'utilisateur. |
| **Mission / Tâche** | Travail assigné (par l'utilisateur ou un bot) avec statut et résultat. |
| **Routine** | Déclencheur (cron, intervalle, ponctuel, événement) qui réveille un bot avec un prompt. Créable par les bots, silencieuse par défaut. |
| **Coffre (vault)** | Stockage chiffré de sessions navigateur, secrets et logins. Partageable entre bots selon des politiques. |
| **Device** | Appareil client appairé (web, mobile, desktop, CLI) avec ses propres tokens révocables. |

---

## 2. Architecture

```
 Clients (Web SPA ; plus tard Expo iOS/Android, Tauri Desktop)
        │ HTTPS REST /api/v1 + WebSocket (événements, bureau VNC)
   ┌────▼──────────── Caddy (TLS auto) ─────────────────┐
   │ HUB (Node 24, TypeScript, Fastify)                  │
   │  ├ API + Auth (devices, tokens, passkeys)           │
   │  ├ Runtime agent (boucle LLM ↔ outils, 1 worker/bot)│
   │  ├ Providers (OpenAI-compat, Command Code, OpenAI)  │
   │  ├ Bus messages (DM, ask/reply, canaux, tâches)     │
   │  ├ Scheduler (pg-boss : heartbeat, routines)        │
   │  ├ Coffre (AES-256-GCM, audit)                      │
   │  └ Passerelle MCP (client MCP, OAuth, routage)      │
   └──┬──────────────┬───────────────────────────────────┘
      │ Postgres 17   │ docker-socket-proxy (API Docker restreinte)
      │ + pgvector    │ réseau interne `mow-net` (token par ordinateur)
      │               │ /srv/mowbot/workspaces (monté dans le Hub + les PC)
  ┌───┴─ Équipe principale ───────────┐ ┌─ Équipe Marketing ─┐ ┌─ Bot solo ─┐
  │ PC d'équipe : Chef + A + B        │ │ PC d'équipe : D, E │ │ PC dédié   │
  │   en même temps                   │ │                    │ │   Bot F    │
  │ PC dédié : Bot C                  │ │                    │ │            │
  │ workspace /workspace (équipe)     │ │ workspace équipe   │ │ workspace  │
  └───────────────────────────────────┘ └────────────────────┘ └────────────┘
```

Principes :

- **Cerveau dans le Hub, mains dans l'ordinateur.** La boucle agent tourne dans le Hub : les clés API ne vont jamais dans les conteneurs, et la logique agent évolue sans reconstruire l'image. Le daemon `mow-agent` est fin (RPC : exec, fichiers, écran, clavier/souris, navigateur) et **multi-bot** (chaque appel porte le `bot_id`).
- **Un seul registre d'outils** côté Hub, exposé à la boucle native et, plus tard, en MCP HTTP pour les runtimes CLI (Claude Code officiel, Codex…).
- **API-first** : contrat OpenAPI 3.1 généré depuis les schémas zod, client TypeScript généré et partagé par tous les clients.

---

## 3. Stack technique

| Couche | Choix |
|---|---|
| Monorepo | pnpm workspaces + Turborepo, TypeScript strict, Biome (lint/format), Vitest |
| Hub | Fastify 5, `fastify-type-provider-zod`, `@fastify/swagger`, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/cors` |
| Base de données | Postgres 17 + pgvector, Drizzle ORM ; PGlite pour le dev/test sans Docker |
| Jobs / cron | pg-boss |
| LLM | Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`) |
| MCP | `@modelcontextprotocol/sdk` |
| Docker | `dockerode` via `tecnativa/docker-socket-proxy` |
| Web | Vite + React + TanStack Router/Query + Tailwind + composants style shadcn/ui ; noVNC |
| Ordinateur | Ubuntu 24.04, TigerVNC (Xvnc) + XFCE4, noVNC côté client (flux relayé par le hub et `mow-agent`), Google Chrome (headed, CDP 9222), xdotool, scrot, tmux, supervisord, Node 24, `mow-agent`, `@playwright/mcp` |
| Déploiement | `docker compose` (caddy, hub, postgres, socket-proxy) ; ordinateurs créés dynamiquement ; runtime Sysbox recommandé |

---

## 4. Providers LLM

### 4.1 Adapters v1

| Adapter | Authentification | Endpoint |
|---|---|---|
| `openai-compatible` | base URL + clé | Chat Completions. Couvre OpenRouter, Ollama, xAI, DeepSeek, vLLM… |
| `command-code` | clé Studio (abonnement Command Code, tous plans sauf Go) | Preset de `openai-compatible` → `https://api.commandcode.ai/provider/v1` (expose aussi `/responses` et `/messages`) |
| `openai` | clé API | Responses API |
| `openai-chatgpt` | « Sign in with ChatGPT » (programme open-source d'OpenAI, OAuth PKCE, scope `chatgpt.tokens.use.direct`) | `POST https://api.openai.com/v1/responses` avec `store: false`, `stream: true` ; modèles via `GET /v1/models` |

### 4.2 Abonnement ChatGPT (`openai-chatgpt`)

- Le callback OAuth est sur `127.0.0.1` : impossible directement sur un serveur distant. MowBot fait le login **dans le navigateur d'un ordinateur** (prise de contrôle) : le callback loopback arrive dans le conteneur, `mow-agent` le capte, le Hub stocke les tokens chiffrés et gère seul les refresh. `ext_agent_host_id` stable, persisté par instance de Hub.
- Le programme est ouvert aux **clients open-source** : MowBot doit être publié en open source pour l'utiliser. Repli : CLI Codex officiel dans l'ordinateur (runtime CLI, phase ultérieure).
- Erreurs de quota `subscription_sharing_usage_limit_exceeded` / `subscription_sharing_usage_unavailable` → bascule sur la chaîne de repli du bot.
- À valider en P2 : appels d'outils (function calling) avec un token d'abonnement.

### 4.3 Plus tard

- `anthropic` (clé API).
- Runtime **Claude Code CLI officiel, non modifié**, dans l'ordinateur, avec login fait par l'utilisateur via le flow Anthropic. C'est la seule voie conforme pour Claude Pro/Max : MowBot ne doit jamais stocker ni relayer de tokens claude.ai, et l'Agent SDK ne peut pas utiliser un abonnement.
- Gemini.

### 4.4 Configuration par bot

`provider_profile` + `model` + **chaîne de repli** (ex. ChatGPT → Command Code → clé API OpenAI) + modèle « léger » pour les heartbeats.

---

## 5. Ordinateurs

### 5.1 Modèle

- Table `computers` : `kind: team | dedicated`, `team_id`, image, ressources, statut, `container_id`. Un bot pointe vers un `computer_id`.
- Au setup : création de l'**Équipe principale**, de son **PC d'équipe** et de son workspace ; le Chef en est le lead.
- Nouvelle équipe → création de son PC d'équipe et de son workspace (PC démarré au premier besoin).
- Réglage du bot **« Ordinateur »** : `PC de l'équipe` (défaut) ou `Nouvel ordi dédié`. Un bot solo a toujours un PC dédié. Le Chef ou un lead choisit via `create_bot(computer: "team" | "new")`.
- Changement de PC ou d'équipe : le répertoire du bot est déplacé dans le nouveau workspace ; les sessions navigateur passent par le coffre (§9).

### 5.2 Image `mowbot/workstation`

- Identique pour PC d'équipe et PC dédié. Utilisateur Linux `bot` avec `sudo NOPASSWD`. Display principal `:0` en 1280×800.
- supervisord lance : Xvnc `:0` (écoute **uniquement en local**), XFCE, **un Chrome partagé** (profil `/home/bot/.config/mowbot-chrome`, `--remote-debugging-port=9222` sur 127.0.0.1), `mow-agent`.
- Le bureau n'est jamais exposé : le navigateur parle RFB en WebSocket au hub (ticket à usage unique), qui relaie vers `mow-agent` (jeton de l'ordinateur), qui relaie vers le VNC local.
- `mow-agent` (HTTP + WS interne, token par ordinateur, chaque requête porte le `bot_id`) :
  - `exec` : sessions tmux par bot, timeout, arrière-plan, streaming ;
  - `fs` : read/write/edit/list/upload/download ;
  - `screenshot`, `input` (xdotool), `display` (displays virtuels) ;
  - `browser` : pages par bot via CDP, screencast, export/import storageState ;
  - `locks`, `control.lock` (prise de contrôle).
- Navigateur : **une instance `@playwright/mcp` par bot**, connectée en CDP au Chrome partagé ; chaque bot ne voit et ne pilote que **ses** fenêtres.
- Volumes : `/home/bot` (persistant, propre à l'ordinateur) ; `/workspace` = workspace de l'équipe (bind de `/srv/mowbot/workspaces/<id>`, monté aussi dans les PC dédiés des bots de l'équipe) ; bot solo → son workspace personnel.
- Installations persistantes : le conteneur n'est jamais recréé hors mise à jour ; chaque installation est ajoutée au journal `/home/bot/.mowbot/provision.sh`, rejoué lors d'une reconstruction.
- Ressources par défaut : PC d'équipe 4 CPU / 8-16 Go ; PC dédié 2 CPU / 4 Go ; configurables.
- **Hibernation** : arrêt du conteneur quand tous ses bots sont inactifs depuis N minutes ; réveil automatique sur événement (~5-10 s).
- Réseau : `mow-net` interne ; aucun port exposé ; VNC proxifié par le Hub.

### 5.3 Travail simultané sur un PC d'équipe

| Ressource | Partage | Concurrence |
|---|---|---|
| Fichiers | workspace de l'équipe (§5.5) | Libre ; `file_lock(path)` (flock) pour les fichiers communs |
| Shell | sessions tmux `bot-<nom>` | Libre, en parallèle |
| Navigateur | **1 Chrome, 1 profil → logins partagés automatiquement** ; fenêtres par bot (titre préfixé `[Nom]`) | Libre : pilotage CDP par page, sans souris OS ni vol de focus (`bringToFront` interdit) |
| Apps GUI / souris OS | display `:0` commun + **display virtuel par bot** (`:N`, à la demande) | `:0` : verrou d'entrée court avec file d'attente ; display perso : libre |
| sudo / apt | commun | `install_package` sérialisé (verrou dpkg) + ajout automatique au journal de provisioning |
| Ports réseau | communs | Registre de ports par bot (`reserve_port`) |
| Processus | communs | `pc_status` : qui fait quoi (fenêtres, processus, verrous, ports) |

- Conscience mutuelle : `pc_status` + annonces d'activité dans le canal de l'équipe. Un bot ne touche pas aux fenêtres ou processus d'un autre sans `ask_bot`.
- **Ce n'est pas une frontière de sécurité** : sur un PC d'équipe, chaque bot voit les fichiers, cookies et sessions des autres. L'isolation passe par un PC dédié ou une autre équipe.

### 5.4 Prise de contrôle

- Panneau « Bureau » dans le chat : vue **PC entier** (noVNC `:0`, lecture seule par défaut) et vue **par bot** (screencast CDP de ses fenêtres + son display virtuel).
- *Prendre le contrôle* d'un ordinateur → pause des actions d'entrée (souris, clavier, navigateur) de **tous les bots de ce PC** ; shells et fichiers continuent.
- *Rendre la main* → événement `takeover_released` + screenshot envoyés à chaque bot concerné.
- Un bot peut demander `request_user_takeover(raison)` (login, 2FA, captcha) → notification ; sa fenêtre passe au premier plan à l'ouverture.

### 5.5 Workspaces (fichiers)

- Un workspace par équipe et par bot solo. Stockage : dossier hôte `/srv/mowbot/workspaces/<id>`, monté en entier dans le Hub (`/data/workspaces`) et par sous-dossier dans chaque ordinateur (`/workspace`). uid/gid `bot` (1000) cohérents.
- Arborescence par défaut :
  - `shared/` — travail commun ;
  - `bots/<nom>/` — répertoire de chaque bot ;
  - `inbox/` — fichiers déposés par l'utilisateur ou partagés par une autre équipe ;
  - `outputs/` — livrables ;
  - `kb/` — base de connaissances de l'équipe en Markdown (lisible par l'utilisateur) ;
  - `.trash/` — corbeille.
- Côté utilisateur (UI + API) : explorateur (arbre, recherche, tri), aperçu (texte/code, Markdown, images, PDF, audio/vidéo), **téléchargement** d'un fichier (Range) ou d'un dossier (zip en streaming), **upload** (glisser-déposer ; upload reprenable pour le mobile), création de dossier, renommage/déplacement, suppression vers la corbeille, mises à jour en direct (`workspace.changed` pour les changements faits via le hub ; rafraîchissement périodique pour ceux faits depuis les ordinateurs), mention « modifié par [bot] » (plus tard).
- Fichiers venant des bots = contenu non fiable : aperçus servis avec `nosniff` et CSP `sandbox`, HTML et scripts servis comme texte, téléchargements toujours en pièce jointe.
- Sécurité : résolution de chemin stricte (pas de traversal, pas de symlink hors workspace), quota par workspace, scopes API `files:read` / `files:write`.
- Partage entre équipes : `share_file(path, to: bot|team)` → copie dans `inbox/` du workspace cible + notification.
- Plus tard : snapshots / versions.

### 5.6 Aperçus web

Montrer à l'utilisateur une page en cours (un serveur de dev sur le PC d'un bot), sur son téléphone ou son ordinateur, en LAN comme depuis internet, sans tunnel public.

- **Un port par aperçu**, sur l'adresse du hub : `MOWBOT_PREVIEW_PORTS` (`8800-8819`). Même hôte, donc même certificat (Caddy sert `domaine:8800` avec celui du domaine ; HTTP simple en LAN) ; les chemins absolus et les WebSockets marchent, ce qu'un proxy en sous-chemin casserait.
- **Joindre le serveur de dev** : `mow-agent` relaie une connexion TCP brute vers le loopback du PC (`GET /tcp?port=N`, upgrade `mowbot-tcp`, authentifié, IPv4 puis IPv6). Le hub y parle HTTP, upgrades WebSocket comprises, en se présentant comme `localhost:N` (`Host`, `Origin`, `Referer` réécrits) : le serveur peut n'écouter que sur localhost, et ses contrôles d'hôte passent. Ports refusés : l'agent, VNC, Chrome DevTools, X11.
- **Accès** : le lien porte un secret (`?mowbot_preview=…`, 24 octets aléatoires, scellé en base). La première visite le remplace par un cookie `httpOnly`, `SameSite=Lax` (`Secure` en HTTPS) propre au port (`mowbot_preview_<port>`), puis redirige sans le secret. Sans cookie valable : une page « aperçu privé », rien n'atteint le serveur du bot.
- **Durée** : jusqu'à `stop_preview` ou l'arrêt depuis l'app, l'arrêt ou la mise en veille du PC, et 24 h au plus (partager à nouveau le même port garde le lien et relance le délai). Un redémarrage du hub ressert les aperçus des PC encore allumés.
- **Cookies partagés entre ports** (le navigateur les range par hôte, pas par port) :
  - vers le serveur du bot : jamais les cookies du hub (`mowbot_*`, avec ou sans préfixe `__Host-`/`__Secure-`), ni ceux des autres aperçus ;
  - depuis lui : les `Set-Cookie` de noms `mowbot_*` (même sans nom) sont supprimés, l'attribut `Domain` est retiré (cookie limité à l'hôte), `Clear-Site-Data` (qui viderait les cookies du hub), `Strict-Transport-Security` et `Alt-Svc` sont supprimés, les redirections vers `localhost:N` repointent sur l'aperçu ;
  - le JavaScript d'un aperçu peut encore poser un cookie `mowbot_refresh` au chemin plus précis (il ne peut pas écraser le vrai, `httpOnly`) : `/auth/refresh` essaie toutes les valeurs reçues ;
  - les ports d'aperçu ne sont jamais des origines CORS, et l'app web refuse d'être affichée dans un cadre (`X-Frame-Options`, `frame-ancestors`), le cookie de session `SameSite` n'empêchant rien entre ports d'un même site.
- **Adresse des liens** : `MOWBOT_PUBLIC_URL`, sinon celle de la dernière requête authentifiée des apps (jamais d'une requête anonyme : un `Host` forgé détournerait le secret). L'API, elle, construit les liens sur l'adresse de chaque requête.
- **Outils** : `share_preview(port, title?, path?)` (vérifie que le port écoute, affiche une carte Ouvrir dans la conversation), `stop_preview(port)` ; les aperçus en cours figurent dans le prompt du bot.
- **Apps** : la page du PC (web, mobile) liste ses aperçus : ouvrir, copier le lien, arrêter. `GET /previews?computerId=`, `DELETE /previews/:id`, événement `previews.changed`.

---

## 6. Runtime agent

- **Un worker single-flight par bot** (advisory lock Postgres).
- Inbox d'événements : `user_message`, `bot_message`, `ask_request`, `ask_reply`, `task_assigned`, `routine_fire`, `heartbeat`, `takeover_released`, `webhook`, `approval_decided`.
- Un tour = contexte (system prompt : identité, mission, équipe et membres, annuaire des autres équipes, ordinateur et workspace, mémoire, règles) + historique compacté → boucle LLM ↔ outils (nombre de steps et budget limités) → persistance des steps → streaming vers les clients.
- Un message de l'utilisateur est prioritaire : injecté au step suivant (ou abandon du step en cours).
- États d'un bot : `idle | working | waiting_user | waiting_bot | paused | hibernated | error`.
- **Runs suspendables** : un outil bloquant (`ask_bot`, approbation) suspend le run en base et le reprend à l'arrivée de la réponse (tool_result). Un cycle A ↔ B est détecté et refusé (suggestion : message asynchrone).
- Compaction automatique du contexte au-delà d'un seuil.

---

## 7. Outils des bots

| Groupe | Outils |
|---|---|
| Organisation | `list_teams`, `create_team(name, mission, lead?)` (Chef), `update_team`, `list_bots(team?)`, `create_bot(…, team: id \| null, computer: team \| new)` (Chef, leads pour leur équipe, bots `can_spawn`), `update_bot`, `move_bot(team)`, `retire_bot`, `set_focus(text)` (ce sur quoi il travaille, affiché à côté de son nom) |
| Communication | `send_message` (tout bot de l'annuaire, sauf équipe cloisonnée), `ask_bot` (synchrone, timeout), `reply`, `post_channel` (canal de son équipe), `assign_task`, `update_task`, `list_tasks`, `share_file(path, to)` |
| Utilisateur | `notify_user(priority: digest \| normal \| urgent)`, `ask_user(question, options)`, `request_user_takeover(reason)` |
| Proactivité | `create_routine`, `list_routines`, `update_routine`, `delete_routine`, `set_heartbeat` |
| Mémoire | `remember(scope: private \| team)`, `recall(query)`, `kb_search` (base de connaissances = `/workspace/kb/`) |
| Ordinateur | `bash`, `read_file`, `write_file`, `edit_file`, `screenshot`, `computer(action…, display)`, `open_display`, `pc_status`, `file_lock` / `file_unlock`, `install_package`, `reserve_port` ; navigateur via `@playwright/mcp` limité aux fenêtres du bot ; `share_preview(port, title?, path?)`, `stop_preview(port)` (§ 5.6) |
| Coffre | `vault_find(service \| domain)`, `vault_use(item_id)`, `vault_capture_session(service, account_label)`, `vault_store_secret`, placeholders `{{vault:item.field}}` |
| MCP | `mcp__<server>__<tool>`, `mcp_search_tools` (chargement à la demande), `mcp_call` ; pour le Chef `mcp_list`, `mcp_add`, `mcp_update`, `mcp_remove`, `mcp_setup` |

Limites par défaut : 20 bots, 10 équipes, profondeur hiérarchique 3. Une équipe **cloisonnée** ne reçoit de messages que via son lead ou le Chef.

---

## 8. Proactivité

- **Heartbeat** par bot (défaut 60 min, heures calmes configurables) avec le modèle léger : revue mission / tâches / inbox → `IDLE` ou action.
- **Routines** : triggers `cron`, `interval`, `once`, `event` (webhook généré, message d'un bot, item du coffre modifié, fichier du workspace modifié, notification MCP).
  - Créées librement par les bots, **silencieuses par défaut** (pas de notification) mais toujours listées, historisées (20 derniers runs) et désactivables dans l'UI.
  - Garde-fous : 20 routines max par bot, intervalle minimum 5 min, budget tokens/jour, désactivation automatique après N échecs. Les triggers événement sont préférés aux crons.
- **Digest quotidien** du Chef : ce que chaque équipe et chaque bot solo a fait.
- **Budgets** : plafond tokens/coût par bot et global ; **pause globale** (kill switch).

---

## 9. Coffre et partage de sessions

- Types d'items : `browser_session` (storageState : cookies + localStorage), `secret`, `login` (identifiant / mot de passe / graine TOTP, saisis uniquement via champ masqué), `file`.
- Métadonnées : service, compte (« joris.perso@gmail.com »), domaines, bot propriétaire, ordinateur, équipe, santé (dernière validation).
- Chiffrement en enveloppe : clé maître `MOWBOT_MASTER_KEY` → clé de données par item, AES-256-GCM.
- **Sur un PC d'équipe, aucun transfert** : Chrome et son profil sont partagés ; un login fait pendant une prise de contrôle profite à tous les bots du PC. Le coffre indexe quand même la session pour que les bots sachent qui a accès à quoi.
- **Entre ordinateurs** (PC d'équipe ↔ PC dédié, entre équipes, bots solo) :
  1. Session ouverte sur l'ordinateur X → `vault_capture_session` (automatique en fin de prise de contrôle, ou à l'initiative du bot) → export CDP → chiffrement et stockage par le Hub.
  2. Un bot sur l'ordinateur Y a besoin du compte → `vault_find("google")` → `vault_use(id)` → politique (défaut : **automatique entre bots**) → le Hub injecte les cookies dans le Chrome de Y. **Les valeurs ne passent jamais par le contexte LLM ni par les logs.**
  3. Échec (session liée à l'appareil) → repli : `ask_bot(bot de X, …)` (délégation) ou prise de contrôle sur Y.
- Rafraîchissement : une routine re-capture la session quand les cookies tournent.
- Politique par item : `auto | ask` (`ask` : l'utilisateur autorise chaque bot une fois, par une question Autoriser / Refuser). Défaut `auto` (même équipe et entre équipes) sauf session d'une équipe **cloisonnée** ; items sensibles (banque…) en `ask`. Historique complet par item. Plus tard : `ask_owner_bot`, accès limités aux domaines nécessaires.
- Secrets dans les commandes : placeholders résolus à l'exécution, valeurs masquées dans les sorties d'outils.
- Exclus du partage : tokens d'abonnement LLM (conditions des providers).

---

## 10. Approbations et autonomie

- Règles par catégorie : `allow | ask_user | deny`, avec « toujours autoriser » depuis la demande.
- Défauts :
  - **automatique** pour l'interne : sudo, installations, routines, création de bots, partage du coffre entre bots ;
  - **demande à l'utilisateur** pour l'externe conséquent : paiement, envoi au nom de l'utilisateur, publication, suppression dans un compte, items sensibles du coffre.
- S'applique aux outils structurés (outils natifs, MCP avec annotations `destructiveHint` / `readOnlyHint`). Les actions faites à la main dans le navigateur sont encadrées par le system prompt et l'audit (limite assumée).

---

## 11. MCP

- Serveurs **distants** (Streamable HTTP, OAuth 2.1 géré par le Hub avec redirection vers l'UI) ou **stdio**, lancés sur le **PC MCP** (`workstation/mcp.Dockerfile`, `MOWBOT_MCP_IMAGE`) : un conteneur à part, sans bureau (Node 24, Python 3, pipx, uv, git, `mow-agent`), démarré au besoin, mis en veille quand il ne sert plus ; son `/home/bot` est un volume. Il ne reçoit aucun secret du hub, seulement ceux de chaque serveur, en variables d'environnement au lancement.
- Portée : globale, équipes ou bots désignés, quel que soit leur PC. Les serveurs installés avant par un bot sur son propre PC y restent, pour les bots de ce PC, jusqu'à leur déplacement sur le PC MCP.
- Le Chef gère les serveurs (`mcp_list`, `mcp_add`, `mcp_update`, `mcp_remove`, `mcp_setup` pour une commande sur le PC MCP) ; les autres bots les lui demandent.
- Les bots n'utilisent un serveur que par ses outils ; un résultat long garde son début (48 000 caractères) et dit qu'il est coupé.
- UI : ajout, OAuth, liste des outils, assignation, logs.

---

## 12. API v1

### 12.1 Conventions

- REST sous `/api/v1`, OpenAPI 3.1 sur `/api/v1/openapi.json`.
- Pagination par curseur, `Idempotency-Key` sur les POST de messages.
- Erreurs au format RFC 9457 (`application/problem+json`).
- Client TypeScript généré (`packages/api-client`) partagé par le web et les futures apps.

### 12.2 Ressources

| Ressource | Opérations |
|---|---|
| `auth` | `status`, `setup`, `login`, `refresh`, `logout` ; plus tard passkeys, TOTP, appairage |
| `me` | profil de l'owner et du device courant |
| `devices` | liste, révocation |
| `teams` | CRUD, lead, politiques |
| `computers` | `start` / `stop` / `restart`, `desktop/ticket`, `takeover`, `status` |
| `previews` | liste (par PC, liens pour l'adresse de la requête), arrêt |
| `bots` | CRUD, `pause` / `resume`, équipe, ordinateur, `screencast/ticket` |
| `workspaces/:id/files` | list, stat, content (Range), upload (multipart + reprenable), mkdir, move, delete → corbeille, restore, `archive` (zip), search |
| `threads`, `messages` | historique, envoi |
| `tasks`, `routines` (+ `runs`), `approvals` (+ décision) | |
| `vault` | métadonnées uniquement, création de secret, audit |
| `mcp-servers` | CRUD, OAuth, outils |
| `providers` | CRUD, login ChatGPT, modèles |
| `usage`, `settings`, `system/pause-all` | |

### 12.3 Temps réel

- WebSocket `/api/v1/events` : `message.created`, `message.delta`, `bot.status`, `run.step`, `tool.call`, `approval.requested`, `notification`, `takeover.state`, `workspace.changed`.
- WebSocket `/api/v1/computers/:id/desktop` : proxy VNC (display `:0` ou display d'un bot).
- WebSocket `/api/v1/bots/:id/screencast` : screencast CDP des fenêtres d'un bot.
- Authentification WebSocket par **ticket à usage unique** obtenu en REST (un navigateur ne peut pas poser d'en-tête sur un WebSocket).

---

## 13. Sécurité

### 13.1 Authentification

- **Setup** : au premier lancement, sans owner, le Hub exige un **jeton de setup** (`MOWBOT_SETUP_TOKEN`, ou généré et affiché dans les logs). Sans lui, personne ne peut s'approprier une instance exposée.
- **Owner** : mot de passe argon2id (P0), puis passkey (WebAuthn) et TOTP.
- **Devices** : chaque client est un device avec ses tokens.
  - Access token court (10 min), JWT EdDSA (Ed25519). Clé privée chiffrée par la clé maître et stockée en base.
  - Refresh token opaque, rotatif, stocké haché (SHA-256), lié au device, organisé en famille. **Réutilisation d'un refresh token déjà consommé → révocation de toute la famille et du device**, événement d'audit.
  - Web : refresh token en cookie `httpOnly`, `Secure`, `SameSite=Strict`, chemin `/api/v1/auth` ; access token en mémoire uniquement.
  - Apps natives : refresh token dans le stockage sécurisé de l'OS (Keychain / Keystore).
  - Liste des devices et révocation ; appairage mobile/desktop par QR code depuis le web (plus tard).
- **Scopes** : `read`, `chat`, `files:read`, `files:write`, `control`, `admin`. **Step-up** (passkey / biométrie) pour le coffre, les providers et le kill switch.

### 13.2 Durcissement

- CORS strict (liste blanche, jamais un port d'aperçu), rate limiting (renforcé sur `auth`), en-têtes de sécurité, audit des événements d'authentification.
- Aperçus web sur l'hôte du hub : cookies cloisonnés par le proxy, app non affichable dans un cadre (§ 5.6).
- TLS via Caddy ; option Tailscale pour un accès privé.
- Ordinateurs : pas de `--privileged`, pas de socket Docker, Sysbox, réseau interne, token `mow-agent` par ordinateur, socket-proxy Docker restreint pour le Hub.
- PC d'équipe = zone de confiance commune à l'équipe ; les équipes sont isolées entre elles (PC et workspace distincts). Bots sensibles → PC dédié ou équipe cloisonnée (signalé dans l'UI).
- Notifications push : champ `devices.push_token` dès P0 ; APNs / FCM / Web Push implémentés plus tard.
- Sauvegardes chiffrées (pg_dump, volumes, workspaces).

---

## 14. Modèle de données

Tables (créées au fil des phases) :

| Domaine | Tables |
|---|---|
| Auth (P0) | `owner`, `devices`, `refresh_tokens`, `audit_log`, `settings` ; plus tard `passkeys` |
| Organisation | `teams` (name, mission, lead_bot_id, computer_id, workspace_id, isolated, policies), `bots` (team_id nullable = solo, manager_id, computer_id, workspace_id, role, domain, mission, system_prompt, provider_profile_id, model, fallback, autonomy, budget, status, heartbeat) |
| Ordinateurs | `computers` (kind team \| dedicated, team_id, ressources, status, container_id), `computer_locks`, `workspaces` (owner team \| bot, path, quota) |
| Conversation | `threads` (kind user_bot \| bot_bot \| team_channel), `messages`, `runs`, `run_steps`, `bot_events`, `asks` |
| Travail | `tasks`, `routines`, `routine_runs`, `approvals`, `approval_rules` |
| Coffre | `vault_items`, `vault_grants` |
| Intégrations | `provider_profiles`, `mcp_servers`, `bot_mcp_servers` |
| Mémoire | `memories` (bot_id nullable = équipe, tsvector, embedding optionnel) |
| Divers | `notifications` |

---

## 15. Interface web

- **Sidebar** : Chef épinglé ; une section par équipe (bots avec pastille de statut, canal, Fichiers, PC) ; section Bots solo.
- **Chat** : streaming, appels d'outils repliables.
- **Bureau** : vue PC entier ou vue d'un bot, en direct, avec prise de contrôle.
- **Fichiers** : explorateur du workspace (arbre, aperçu, téléchargement fichier ou zip, upload, corbeille).
- **Équipes** : création, lead, membres, PC, cloisonnement.
- **Ordinateurs** : liste, qui travaille dessus, ressources, verrous.
- **Réglages du bot** : équipe ou solo, ordinateur (PC de l'équipe / nouvel ordi dédié), modèle, autonomie, budget.
- Fil inter-bots (lecture), organigramme, tâches (kanban), routines, approbations, coffre, MCP, providers, appareils et sécurité, activité et coûts, réglages globaux (autonomie, budgets, pause globale).
- Responsive dès le départ ; accessible depuis le réseau local.

### 15.1 Langage visuel (web et futures apps)

- **Sombre, noir et blanc (yin/yang)** : fond quasi noir, surfaces en verre sombre, accent **blanc** (texte noir sur blanc pour les éléments clés, ex. les messages de l'utilisateur). Pas de vert ; les seules couleurs viennent des bots et des états (erreur, transition).
- **Pas de lueurs** : ni halo ni ombre lumineuse. Les boutons principaux ont un **trait de lumière qui parcourt leur bordure** et s'inversent en blanc au survol.
- **Mouvement** : ressorts amortis sans rebond ; les éléments apparaissent en passant du flou au net ; le texte « en cours » est balayé d'un reflet. Si le système demande moins d'animations, seuls les mouvements continus s'arrêtent.
- **Personnages** : chaque bot est un personnage plat de couleur unie (cercle le plus souvent) avec deux petits yeux blancs en pilules, sans pupille ; la position des yeux montre où il regarde. Ils clignent à leur propre rythme, jettent des coups d'œil, suivent le curseur sur les grands formats, et changent d'expression selon l'état : réfléchit (regard en l'air, points en orbite), travaille (yeux plissés qui lisent, arc qui tourne), attend (yeux grands ouverts, anneau qui pulse), dort (yeux fermés), erreur (yeux inquiets, pastille rouge). Une équipe s'affiche comme une grappe de ses membres.
- Le génome (forme, couleur, yeux, rythme) est tiré de la graine du bot par `@mowbot/design`, partagé par tous les clients.
