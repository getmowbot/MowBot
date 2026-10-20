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
- [x] Vérifié de bout en bout sur Docker Desktop (Windows) : PC allumé en ~3 s, bureau XFCE + Chrome dans l'UI, souris et clavier transmis, fichier créé dans le PC visible dans l'explorateur, arrêt / redémarrage avec home conservé
- [ ] Reportés : quotas de workspace, upload reprenable, arm64 avec navigateur, limites CPU/RAM par PC, réseau isolé par équipe, journal `provision.sh`

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
