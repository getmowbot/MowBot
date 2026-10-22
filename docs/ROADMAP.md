# MowBot — Roadmap

> Voir [SPEC.md](SPEC.md) pour le détail fonctionnel. Chaque phase se termine par une démo vérifiable (« Fini quand »).

## Phases

| Phase | Contenu | Fini quand |
|---|---|---|
| **P0 Fondations** | Monorepo pnpm/Turborepo, compose (caddy, hub, postgres, socket-proxy), Drizzle + migrations, OpenAPI, auth owner (jeton de setup, mot de passe) + devices + refresh rotatif, client TS généré, shell web (setup, login, layout, appareils), CI GitHub Actions | `docker compose up` → setup de l'owner, login, device listé, `/api/v1/openapi.json` valide, CI verte |
| **P1 Ordinateur & fichiers** | Image workstation, `mow-agent` multi-bot, entités `teams` / `computers` / `workspaces` + Équipe principale au setup, cycle de vie via dockerode, proxy VNC, panneau Bureau + prise de contrôle, hibernation, explorateur Fichiers (parcourir, aperçu, télécharger, uploader) | PC de l'équipe démarré depuis l'UI, bureau visible, prise et remise de contrôle ; un fichier créé dans le PC est visible et téléchargeable dans l'UI |
| **P2 Cerveau** | 4 adapters providers + login ChatGPT via l'ordinateur, boucle agent, outils ordinateur + `@playwright/mcp`, chat avec le Chef en streaming, budgets de base | **MVP** : on parle au Chef, il utilise le PC de l'équipe (shell, navigateur) et dépose ses livrables dans le workspace |
| **P3 Équipes** | `create_team` / `create_bot` (équipe ou solo), plusieurs équipes, leads, messages, ask/reply suspendable, tâches, travail simultané (tmux, fenêtres Chrome par bot, displays virtuels, verrous, `pc_status`), screencast par bot, option PC dédié, `share_file` entre équipes, organigramme, fil inter-bots, approbations | Le Chef crée une 2e équipe et un bot solo ; 2 bots travaillent en même temps sur le même PC sans se gêner ; chaque équipe a son workspace |
| **P4 Proactivité** | Heartbeat, routines (cron / intervalle / ponctuel / événement / webhook), notifications + digest, chaîne de repli des providers, pause globale | Un bot crée seul une routine pertinente et l'exécute |
| **P5 Coffre** | Index des sessions, capture / injection entre ordinateurs, secrets + placeholders + masquage, politiques, audit | Login Google sur le PC d'une équipe → un bot d'une autre équipe ou un bot solo accède au compte sans intervention |
| **P6 MCP** | Passerelle, serveurs distants + OAuth, stdio dans `mcp-runner`, installation locale par un bot, UI | Un MCP ajouté dans l'UI est utilisé par un bot |
| **P7 Mémoire** | Notes privées / équipe, recherche plein texte, compaction, skills (procédures réutilisables), embeddings optionnels | Un bot se souvient d'une préférence d'une semaine à l'autre |
| **P8 Durcissement & clients** | Passkeys, TOTP, appairage QR, Web Push, sauvegardes, observabilité, tests de charge ; puis app Expo (iOS/Android) et Tauri (desktop) | Apps natives appairées par QR, notifications push |
| **Ensuite** | Anthropic (clé API + Claude Code CLI officiel), Gemini, Codex CLI en repli | — |

## État de P0

- [x] Monorepo (pnpm, Turborepo, Biome, Vitest, TypeScript strict)
- [x] Hub Fastify : santé, OpenAPI, erreurs RFC 9457, rate limit, CORS, helmet
- [x] Base : Drizzle (Postgres en prod, PGlite en dev/test), migrations au démarrage
- [x] Auth : jeton de setup, owner (argon2id), devices, access JWT EdDSA, refresh rotatif avec détection de réutilisation, scopes, logout, révocation
- [x] Client TS généré depuis l'OpenAPI
- [x] Web : setup, login, layout, page Appareils
- [x] Compose (caddy, hub, postgres, socket-proxy), Dockerfiles, CI — build des images à valider (job `docker` de la CI)
- [ ] Passkeys, TOTP, appairage QR (reportés en P8)

## État de P1

- [x] Modèle `workspaces` / `teams` / `computers`, Équipe principale + PC + workspace créés au setup (et au démarrage pour les instances existantes)
- [x] Image `mowbot/workstation` : Ubuntu 24.04, XFCE, TigerVNC (local uniquement), Chrome (amd64), sudo, Node 24, supervisord
- [x] `mow-agent` : santé, verrou de prise de contrôle, exec, capture d'écran, entrées xdotool, pont VNC ↔ WebSocket authentifié
- [x] Cycle de vie Docker (dockerode, réseau `mowbot-computers`, volume home par PC, workspace monté sur `/workspace`), démarrage en arrière-plan, réconciliation au redémarrage du hub
- [x] Hibernation après inactivité (pas pendant qu'un bureau est ouvert)
- [x] Bureau en direct (noVNC via le hub), prise de contrôle / rendre la main, retour automatique aux bots quand l'appareil qui a la main ferme le bureau
- [x] Explorateur Fichiers : navigation, aperçu (texte, image, PDF, audio, vidéo), téléchargement fichier ou dossier (zip) par lien à usage unique, import, création de dossier, renommage, corbeille
- [x] Flux d'événements WebSocket (`computer.updated`, `workspace.changed`)
- [x] Aperçus web : un serveur de dev du PC d'un bot servi sur un port de l'adresse du hub (`MOWBOT_PREVIEW_PORTS`), lien secret échangé contre un cookie, WebSockets / HMR, cookies du hub cloisonnés, `share_preview` / `stop_preview`, liste dans la page du PC (web, mobile)
- [x] Vérifié de bout en bout sur Docker Desktop (Windows) : PC allumé en ~3 s, bureau XFCE + Chrome dans l'UI, souris et clavier transmis, fichier créé dans le PC visible dans l'explorateur, arrêt / redémarrage avec home conservé
- [ ] Reportés : quotas de workspace, upload reprenable, arm64 avec navigateur, limites CPU/RAM par PC, réseau isolé par équipe, journal `provision.sh`

## État de P2

- [x] Fournisseurs : OpenAI-compatible, Command Code (preset), OpenAI (Responses API) ; clés chiffrées, test de connexion par la liste des modèles ; le premier fournisseur est donné au Chef
- [x] Chef créé avec l'Équipe principale, sur son PC ; modèle choisi par bot
- [x] Runtime : une file par bot, boucle LLM ↔ outils (AI SDK v7, 30 étapes max), streaming (`message.delta`), points de contrôle à chaque outil, arrêt en cours de réponse, reprise après redémarrage du hub, usage de tokens par réponse
- [x] Outils : `bash`, `read_file` / `write_file` / `list_files` (limités à `/workspace`), `open_url` (Chrome partagé via DevTools), `screenshot` (image jointe à l'étape suivante, jamais stockée dans l'historique), `computer` (souris et clavier, refusé pendant une prise de contrôle) ; le PC s'allume tout seul
- [x] Interface : thème sombre noir et blanc (yin/yang), bots en personnages (couleur unie, yeux en pilules qui clignent et regardent, humeur selon l'état), chat en streaming avec cartes d'action, panneau « Voir le PC », page Modèles
- [x] Accès depuis le LAN (dev : `host: true` ; prod : adresses LAN dans `MOWBOT_DOMAIN`)
- [x] Chat lisible : les actions et le raisonnement entre deux réponses tiennent sur une ligne grise (ce que le bot fait en ce moment, puis un résumé), dépliable en historique ; les bots décrivent leurs actions (`intent`)
- [x] PC rangé : `open_url` réutilise l'onglet du bot, `list_windows` / `close_windows`, consigne de ranger en fin de tâche ou de sujet, et filet de sécurité : ce qu'un bot a ouvert est fermé après 10 min d'inactivité (pas pendant une prise de contrôle)
- [x] En-têtes HTTP par fournisseur (ex. `x-cmd-zdr: 1`, Zero Data Retention de Command Code), fournisseurs modifiables dans l'UI
- [x] Renommer un bot (son dossier suit) et vider sa conversation
- [x] Vérifié de bout en bout avec un fournisseur simulé sur le vrai PC Docker : commande, page ouverte, capture, fichier écrit, réponse Markdown
- [ ] Abonnement ChatGPT (« Sign in with ChatGPT ») : en attente du choix de licence open source
- [ ] Navigateur piloté via `@playwright/mcp` (arrive avec la passerelle MCP, P6) ; budgets par bot

## État de P3

- [x] Équipes : création, réglages (mission, lead, cloisonnement), suppression d'une équipe vide (PC supprimé, fichiers dans la corbeille de l'Équipe principale) ; le Chef est lead de l'Équipe principale
- [x] Bots : création dans une équipe (PC de l'équipe ou PC dédié) ou solo (PC et fichiers à lui), réglages, suppression ; noms uniques
- [x] Le Chef crée équipes et bots (`create_team`, `create_bot`), un lead crée des bots dans son équipe ; `update_bot`
- [x] Communication : `send_message`, `ask_bot` (attend la réponse ; refuse les blocages mutuels ; réponse tardive transmise en message), `list_bots` ; équipes cloisonnées joignables seulement par leur lead ou le Chef
- [x] Tâches : `assign_task`, `update_task`, `list_tasks`, l'autre partie prévenue à chaque changement de statut ; l'utilisateur peut aussi confier et annuler des tâches
- [x] Garde-fous : 10 échanges en chaîne entre bots sans l'utilisateur, 60 envois par bot et par heure
- [x] PC partagé : l'écran pris à tour de rôle (captures, souris, clavier, page au premier plan), `pc_status` (qui fait quoi, onglets et processus de chacun), `lock_file` / `unlock_file`
- [x] Interface : équipes et bots dans la barre latérale, page d'équipe, organigramme, page Activité (tâches + échanges entre bots), messages des autres bots dans le chat, réglages et suppression d'un bot, PC et fichiers des PC dédiés et des bots solo
- [x] Vérifié avec un modèle simulé : le Chef pose une question à un bot, attend sa réponse, lui confie une tâche ; le bot écrit le livrable et la marque terminée ; le Chef est prévenu
- [x] P3b, navigateur par bot :
  - chaque bot a sa propre fenêtre de Chrome, pilotée par DevTools (pont `/cdp` de mow-agent), sans souris, clavier ni écran ;
  - outils `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_scroll`, `browser_back`, `browser_screenshot` : texte de la page et éléments numérotés ;
  - plusieurs bots naviguent en même temps sur le même PC, avec les connexions de Chrome partagées ;
  - `open_url` retiré.
- [x] Vue live de la fenêtre de chaque bot dans « Voir le PC » et le panneau PC du chat, avec un bouton « Afficher à l'écran » pour prendre la main.
- [x] Le PC est recréé quand l'image des ordinateurs change (le dossier `/home/bot` est gardé).
- [x] `ask_user` : question avec réponses en boutons, dans le chat et sur l'accueil, avec notification.
  - La réponse arrive au bot comme un message de l'utilisateur.
  - Écrire au bot dans le chat clôt ses questions ouvertes.
  - 3 questions ouvertes au plus par bot.
- [x] `share_file` : copie d'un fichier ou d'un dossier dans `inbox/` d'une autre équipe ou d'un bot solo ; le destinataire (ou le lead) est prévenu.
- [x] Déplacer un bot vers une autre équipe ou le rendre solo, depuis l'app (menu du bot) ou par le Chef (`move_bot`).
  - Le bot s'arrête et range ce qu'il a ouvert.
  - Son dossier le suit.
  - Son ancien PC dédié est supprimé.
  - L'espace d'un ancien bot solo va dans la corbeille de l'Équipe principale.
- [x] Vérifié sur un vrai PC avec un modèle simulé : deux bots naviguent en même temps (ouvrir, cliquer, capturer), posent leur question, reçoivent la réponse, et un bot change d'équipe (son onglet est fermé, son dossier déplacé).
- [ ] Plus tard : displays virtuels par bot, canal d'équipe, approbations.

## État de P4

- [x] Routines : déclencheurs cron, intervalle, une fois, webhook (URL secrète, contenu transmis au bot comme donnée) ; créées par les bots (`create_routine`…) ou par l'utilisateur ; silencieuses par défaut ; 20 par bot, 5 min d'écart minimum, désactivées après 3 échecs de suite (l'utilisateur est prévenu) ; historique des 20 derniers passages ; lancement à la main
- [x] Réveils périodiques (heartbeat) par bot, avec heures calmes ; un réveil sans rien à faire (« RAS ») ne laisse pas de trace dans la conversation
- [x] Bilan du jour du Chef (19 h, `activity_report` + `notify_user`)
- [x] Notifications : `notify_user` (urgent, normal, digest gardé pour le bilan), liste et lecture
- [x] Budgets de jetons par jour (par bot et global) sur ce que les bots font d'eux-mêmes
- [x] Chaîne de modèles de repli et modèle léger pour les réveils
- [x] Pause globale : tout s'arrête, les échanges entre bots attendent la reprise, les bots répondent encore à l'utilisateur
- [x] Langue du compte (FR/EN) : les bots répondent dans la langue de l'utilisateur
- [x] Page d'accueil : les canvas que les bots y épinglent (score avec logos, liste à cocher, chiffres, note, HTML sans script), notifications, demande rapide au Chef, pause globale ; l'utilisateur range, redimensionne, retire ou supprime les cartes (4 par bot, 24 en tout)
- [x] Pages Routines (déclencheur, prochain passage, historique, lancement à la main, URL de webhook) et Proactivité (pause, heures calmes, budgets, réveils, modèles léger et de secours)
- [x] Interface web en français et en anglais (langue du compte) ; aperçu des fichiers Markdown mis en forme
- [ ] Web Push et notifications sur mobile (P8)

## État de P5

- [x] Coffre chiffré en enveloppe : une clé par entrée, elle-même scellée par la clé maître ; les valeurs ne sortent jamais du hub (ni vers l'app, ni vers un modèle)
- [x] Sessions de sites (cookies + localStorage des pages ouvertes) : capturées depuis le Chrome d'un PC par un bot (`vault_save_session`), par l'utilisateur (choix du PC et du site) ou automatiquement en fin de prise de main (sites visités dont les cookies de connexion ont changé) ; chargées dans le Chrome d'un autre PC (`vault_use_session`), rafraîchies depuis le PC d'origine s'il est allumé
- [x] Identifiants (nom, mot de passe, graine 2FA) et secrets : saisis dans des champs masqués ou rangés par un bot (`vault_save_secret`) ; utilisés par placeholders `{{vault:ref.champ}}` dans `bash`, `browser_type` et `computer` (type), remplis au moment de l'action ; code 2FA calculé (RFC 6238)
- [x] Masquage : toute valeur du coffre est remplacée par « [secret masqué] » dans les sorties d'outils (y compris le texte des pages) ; les champs mot de passe ne sont jamais lus dans les aperçus de page
- [x] Politiques : `auto` (défaut) ou `ask` (question à l'utilisateur, Autoriser / Refuser, retenue par bot, révocable) ; une équipe cloisonnée garde ses sessions
- [x] Historique par entrée (captures, usages, demandes, décisions) ; le prompt de chaque bot liste le coffre
- [x] Pages Coffre (web et app) ; vider l'onglet Activité et les notifications
- [ ] Politique « demander au bot propriétaire », entrées de type fichier, vérification de santé des sessions (plus tard)

## App desktop et projets locaux

- [x] App Tauri : la fenêtre affiche l'interface du hub (adresse demandée au premier lancement), icône de la barre des tâches, fermer la fenêtre garde le connecteur actif
- [x] Connecteur Rust : WebSocket sortante vers le hub avec son propre jeton (révocable), reconnexion automatique ; list, read, write, edit, find, search (.gitignore respecté), exec (PowerShell sous Windows) ; chemins vérifiés (liens symboliques compris), rien hors des dossiers partagés
- [x] Hub : connecteurs et projets, outils local_* des bots, accord de l'utilisateur pour chaque commande (Autoriser / Tout autoriser dans ce projet / Refuser) ou mode auto, portée par équipes ou bots
- [x] Pages Projets (web et app) : relier ce PC et partager un dossier depuis l'app desktop, mode, portée, ordinateurs reliés
- [x] Copier un projet sur le PC d'un bot (local_pull : incrémental, .gitignore, garde les changements du bot) et rapporter ses changements en branche git (local_push), sans toucher au dossier de l'utilisateur
- [x] Fenêtre sans barre système (boutons intégrés à l'interface), adresse du hub au premier lancement, dans Profil ou avec `--hub`
- [x] Installeurs Windows, macOS et Linux (workflow « Desktop app ») et commande d'installation Linux
- [x] Profil : nom, mot de passe du hub (avec déconnexion des autres appareils)
- [ ] Partager les serveurs MCP de l'ordinateur ; installeurs signés et mises à jour automatiques

## État de P6

- [x] Serveurs MCP distants (Streamable HTTP, repli SSE) avec en-têtes secrets scellés ou connexion OAuth 2.1 (enregistrement dynamique, PKCE, jetons gardés chiffrés et rafraîchis par le hub)
- [x] Serveurs MCP locaux (stdio) lancés sur le PC d'un bot : mow-agent relaie le processus par WebSocket (`/stdio`), le PC démarre au besoin ; les secrets arrivent en variables d'environnement
- [x] Portée : tous les bots, des équipes ou des bots choisis ; un bot installe lui-même un serveur sur son PC (`mcp_add_local`, `mcp_remove_local`), réservé aux bots de ce PC
- [x] PC MCP : les serveurs locaux tournent sur leur propre ordinateur (image `mowbot/mcp`, sans bureau, démarré au besoin), plus sur ceux des bots ; le Chef les gère (`mcp_list`, `mcp_add`, `mcp_update`, `mcp_remove`, `mcp_setup`) et les autres bots les lui demandent ; les anciens serveurs locaux se déplacent sur le PC MCP depuis les pages MCP
- [x] Résultats MCP longs : le début est gardé (48 000 caractères) avec une note qui invite à demander moins ; les bots n'utilisent un serveur que par ses outils
- [x] Outils exposés `mcp__<serveur>__<outil>` (jusqu'à 40), au-delà `mcp_search_tools` + `mcp_call` ; images des résultats montrées au modèle ; valeurs du coffre masquées
- [x] Journal des appels par serveur (200 derniers), état (ok, erreur, connexion requise), connexions fermées après inactivité
- [x] Pages MCP (web et app) : ajout, connexion OAuth, outils, portée, activation, journal
- [ ] Annotations `destructiveHint` reliées aux approbations, notifications MCP comme déclencheurs de routine (plus tard)

## Risques

1. **Conditions des providers** : l'abonnement ChatGPT n'est utilisable que via le programme open-source officiel (MowBot doit être open source) ; Claude Pro/Max uniquement via le CLI Claude Code officiel non modifié. Les limites des abonnements supposent un « usage individuel ordinaire » → une proactivité massive consomme vite les quotas.
2. **Sécurité** : un PC d'équipe n'isole pas les bots entre eux ; sudo + sessions partagées + injection de prompt depuis le web = exfiltration possible. Mitigations : PC dédié pour les bots sensibles, accès par domaine entre ordinateurs, items sensibles en `ask_user`, audit, alertes, proxy de sortie journalisé en option. Risque résiduel assumé et documenté.
3. **Conflits sur un PC d'équipe** : bots qui se marchent dessus (fichiers, fenêtres, ports, apt, CPU/RAM). Mitigations : verrous, répertoires par bot, CDP sans focus, displays virtuels, `pc_status`, quotas cgroups si besoin.
4. **Coûts et quotas** : budgets, modèle léger pour les heartbeats, triggers événement plutôt que cron.
5. **Détection anti-bot** : Chrome réel en mode fenêtré (pas headless), IP du serveur ; les sessions liées à l'appareil peuvent casser le partage → repli par délégation.
6. **Ressources** : un PC par équipe (8-16 Go) + ~2-4 Go par PC dédié ou bot solo → hibernation des PC inactifs ; dimensionner le serveur selon le nombre d'équipes et de PC dédiés.

## Décisions en attente

- **Licence open source** (requise pour le programme « Sign in with ChatGPT »).
- Nom de domaine et mode d'exposition (public + TLS, ou Tailscale uniquement).
