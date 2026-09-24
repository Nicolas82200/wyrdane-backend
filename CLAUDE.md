# CLAUDE.md

Ce fichier fournit le contexte du projet à Claude Code pour travailler efficacement sur le backend de Wyrdane.

## Vue d'ensemble

**wyrdane-backend** est l'API partagée du TCG **Wyrdane** (voir le client du jeu dans `E:\card-game`, développé sous Godot 4/GDScript). Elle sert deux consommateurs :
- le **client de jeu** (Godot, multijoueur Steam) pour la progression persistante : collection de cartes, classement (ranked), boutique de cosmétiques
- un **site web compagnon** (deck builder) permettant de créer/modifier ses decks en dehors du jeu

Ce backend est né d'une copie du backend développé pour un projet de formation (`Formation/P4`, deck builder MySQL/Express) — cette base initiale a été conservée intacte dans `Formation/P4`, ce repo est son évolution indépendante pour Wyrdane.

## Stack technique

- **Node.js / TypeScript / Express 5**, exécuté en dev via `tsx watch`
- **MySQL** (via `mysql2/promise`), schéma dans `backend/src/database/schema.sql`
- **Auth Steam uniquement** — pas de mot de passe. Le client envoie un ticket de session Steam (obtenu via GodotSteam `Steam.getAuthSessionTicket()`), le backend le vérifie auprès de l'API Web Steamworks (`ISteamUserAuth/AuthenticateUserTicket`) puis émet un JWT dans un cookie httpOnly
- Session : JWT signé (`jsonwebtoken`), lu/écrit via cookie `auth_token` (voir `src/middleware/auth.ts`)

## Structure du projet

```
backend/
├── src/
│   ├── app.ts            # Config Express (cors, cookie-parser, fichiers statiques, 404)
│   ├── index.ts           # Point d'entrée, écoute sur PORT
│   ├── controller/        # authController (steamLogin/logout/authVerif), userController, cardController, deckController
│   ├── model/              # Requêtes SQL (userModel, cardsModel, decksModel, db.ts = pool mysql2)
│   ├── router/              # Montage des routes sous /api
│   ├── middleware/         # auth.ts (cookie JWT), csrf.ts (header requis sur les routes authentifiées), rateLimit.ts
│   ├── helper/               # steamHelper (vérif ticket Steam), jwtHelper (encode/decode), matchPayload.ts (bornage cardsPlayedByRace/deckRaces déclarés par le client)
│   └── database/            # schema.sql + cards_data.sql (seed des cartes)
└── public/assets/card_art/  # Images des cartes servies statiquement
```

## Authentification — flow Steam

Deux flows cohabitent, tous deux terminés par le même JWT en cookie httpOnly :

**Ticket de session (client de jeu, GodotSteam)**
1. Le client obtient un ticket de session Steam (`Steam.getAuthSessionTicket()`).
2. `POST /api/auth/steam` avec `{ ticket }` → `steamHelper.authenticateSteamTicket()` interroge l'API Web Steamworks pour valider le ticket et récupérer le `steamid`.

**OpenID web (site compagnon, popup navigateur)**
1. `GET /api/auth/steam/redirect` (`steamOpenIdHelper.buildAuthUrl`) redirige vers la page de connexion Steam officielle, avec un `realm`/`return_to` dérivé de l'origine de la requête (branding par domaine — site vs jeu si besoin un jour).
2. Steam renvoie sur `GET /api/auth/steam/callback`, vérifié via `steamOpenIdHelper.verifyAssertion` (assertion OpenID, pas de ticket) pour en extraire le `steamid`.
3. Le site web ouvre ce flow dans une popup (`useSteamLoginPopup.ts` côté `wyrdane-website`) plutôt qu'une redirection pleine page, pour rester sur la même page après connexion.

**Commun aux deux flows**
1. Le backend cherche ce `steamid` dans `linked_accounts` (table qui associe un `user_id` interne à une identité externe : `provider` + `external_id`). S'il n'existe pas, un `user` et sa ligne `linked_accounts` sont créés en une transaction (`userModel.createWithSteamAccount`).
2. `ensureAdminFromEnv` marque le compte admin si son `steamid` figure dans `ADMIN_STEAM_IDS` (variable d'env, liste séparée par virgules) — vérifié à chaque login, pas seulement à la création du compte.
3. `recordLogin` journalise la connexion (origine site vs jeu, déduite du flow utilisé) — alimente le tableau de bord admin (`GET /api/admin/stats`).
4. Un JWT `{ id, name }` est signé et posé en cookie httpOnly `auth_token` — identique à l'ancien flow email/mot de passe, seule l'étape de vérification d'identité a changé.

**Pourquoi `linked_accounts` plutôt qu'une colonne `steam_id` sur `users`** : ça garde la porte ouverte à d'autres providers (email, Google, Apple Sign-In) si un client mobile voit le jour un jour, sans avoir à migrer le schéma ni changer l'identifiant interne du joueur (`user_id`) qui porte déjà collection/decks/progression.

Variables d'environnement nécessaires (voir `.env.sample`) : `STEAM_WEB_API_KEY` et `STEAM_APP_ID` (clé Web API générée sur https://partner.steamgames.com pour l'AppID du jeu), `ADMIN_STEAM_IDS` (comptes admin).

## Admin & analytics

Routes protégées par statut admin (`adminRouter.ts`) : `GET /api/admin/me` (vérifie le statut admin du compte courant), `GET /api/admin/stats` (fréquentation, connexions Steam par origine site/jeu, utilisateurs uniques — alimenté par `recordLogin` et le tracking de pageviews), `PUT /api/admin/wishlist` (compteur de wishlist Steam saisi manuellement, pas d'API Steamworks publique pour ce chiffre). Consommé côté site par une page `/admin` non listée dans la navigation (accès direct par URL). Pageviews trackées via `POST /api/analytics/pageview` (`analyticsRouter.ts`), appelé à chaque navigation SPA côté site (`usePageviewTracking.ts`).

## Notifications Discord

`discordHelper.ts` (`sendDiscordWebhook`) relaie des évènements en direct sur un salon Discord de développement via un webhook entrant (Paramètres du salon > Intégrations > Webhooks), lu à l'usage depuis `DISCORD_CRASH_WEBHOOK_URL` (nom historique — réutilisé pour tout ce qui suit, pas seulement les crashs). Soft no-op silencieux si la variable est absente (dev local sans webhook configuré) : jamais d'erreur remontée à l'appelant. Le salon cible est un salon de **forum** : chaque appel fournit un `threadName` (tronqué à 100 caractères), qui ouvre un nouveau fil par évènement — nécessaire sur ce type de salon, sans effet sur un salon textuel classique. Aucune table dédiée pour aucun de ces trois flux : c'est un relais direct, rien n'est conservé en base une fois le message posté (si une vraie persistance/historique est utile un jour, à construire séparément).

- **`crashReportController.ts`** (`POST /api/crash-report`, public, pas d'auth) : crash/gel signalé depuis le jeu (voir `CrashReporter.gd` côté `card-game`). Log complet du joueur joint en pièce jointe `.txt` (via `sendDiscordWebhook(embed, threadName, attachment)`, requête multipart), un aperçu de sa fin reste aussi dans un field de l'embed pour lecture rapide sans télécharger le fichier.
- **`reportsController.ts`** (`POST /api/reports`, authentifié) : signalement bug/triche depuis le menu Échap en partie. Pseudo du signalant et, pour un signalement Triche, pseudo du joueur signalé (résolu côté serveur via `reportedUserId`, jamais fait confiance au client) inclus dans l'embed.
- **`contactController.ts`** (`POST /api/contact`, public) : seule la catégorie "Bug / problème en jeu" du formulaire "Nous contacter" du site part sur Discord — les autres catégories (question générale, candidature illustrateur, partenariat/presse) restent envoyées par mail (`mailHelper.ts`), une candidature ou une demande de partenariat n'ayant pas sa place sur ce salon.

Important côté déploiement : `docker-compose.yml` doit explicitement lister `DISCORD_CRASH_WEBHOOK_URL: ${DISCORD_CRASH_WEBHOOK_URL}` dans le bloc `environment:` du service `backend` — une variable présente dans le `.env` du VPS mais absente de ce bloc reste invisible pour le conteneur quel que soit le redémarrage effectué (piège rencontré en prod le 2026-09-18 : la route répondait 200 sans jamais rien poster sur Discord, jusqu'à l'ajout de cette ligne).

## Lancer le projet

```
cd backend
npm install
npm run dev          # tsx watch src/index.ts, port défini par PORT (.env)
```

- Importer `src/database/schema.sql` (puis `cards_data.sql`) dans une instance MySQL locale avant de lancer le serveur.
- Copier `.env.sample` en `.env` et renseigner les identifiants MySQL + `TOKEN_SECRET` + `STEAM_WEB_API_KEY`/`STEAM_APP_ID`.
- **Piège encodage** : le client CLI `mysql` (celui du conteneur `mysql:8`, pas le pool applicatif `mysql2`) négocie `character_set_client=latin1` par défaut faute de locale dans le conteneur — même si la colonne est en `utf8mb4`. Toute correction manuelle ponctuelle de données (`mysql ... < fichier.sql`) sans forcer l'encodage corrompt silencieusement les accents en écriture (mojibake type "Ã©"), déjà arrivé une fois sur `cards` (voir PR de fix associée, corrigée par un re-import avec le bon flag). Toujours ajouter `--default-character-set=utf8mb4` à toute invocation manuelle du client `mysql` en écriture. Le pool applicatif (`db.ts`) et `migrate.ts`/`sync.ts` déclarent maintenant `charset: "utf8mb4"` explicitement, donc ce risque ne concerne que les interventions manuelles ad-hoc, pas l'application elle-même.

## Roadmap (voir aussi la section correspondante dans `E:\card-game\CLAUDE.md`)

Le trigger pour l'existence de ce backend : trois features prévues côté jeu qui ont besoin d'un état serveur autoritatif — classement (ranked), collection de cartes débloquée persistante, boutique de cosmétiques (Steamworks Microtransactions exige un serveur pour finaliser chaque transaction, `FinalizeTxn`).

Déjà en place : auth Steam, gestion des decks (CRUD), catalogue de cartes, collection persistante + monnaie molle + boutique de packs, classement ranked (MMR Elo, double-report de match, leaderboard), file d'attente de matchmaking classé par MMR (voir « Matchmaking classé » ci-dessous), niveau de compte par XP (voir « Niveau de compte (XP) » ci-dessous, a remplacé l'ancien barème d'or par match classé), boutique de cosmétiques (ledger d'achats Steamworks Microtransactions), quêtes quotidiennes (voir « Quêtes quotidiennes » ci-dessous), récompense de connexion quotidienne (voir « Récompense de connexion quotidienne » ci-dessous), quêtes hebdomadaires et parrainage à sens unique (voir « Quêtes hebdomadaires & parrainage » ci-dessous), quêtes uniques (voir « Quêtes uniques » ci-dessous), système d'amis Wyrdane + chat + présence (voir « Amis, chat et présence » ci-dessous).

### Amis, chat et présence

Demandé côté utilisateur le 2026-09-24 (voir `E:\card-game\TODO.md` P15) : système d'amis propre à Wyrdane, **distinct** de la liste d'amis Steam (celle-ci reste gérée nativement, voir `SteamService.open_friends_overlay` côté client — le badge Steam vs Wyrdane d'un ami est calculé côté client en croisant sa liste d'amis Steamworks avec ses amis Wyrdane, aucune donnée Steam ne transite par ce backend).

- **`friendships`** (une ligne par relation, sens `requester_id -> addressee_id`, `status` `pending`/`accepted`, voir schema.sql pour le détail) : `POST /api/friends/requests` envoie une demande — si l'autre joueur avait déjà une demande pending vers nous, elle est auto-acceptée plutôt que de créer une seconde ligne symétrique (`friendModel.sendFriendRequest`). `POST /api/friends/requests/:id/accept` accepte. `DELETE /api/friends/:id` sert à la fois à refuser une demande reçue, annuler une demande envoyée, et supprimer un ami existant (même opération, une simple suppression de ligne — pas de `status='declined'` persistant). `GET /api/friends` liste les amis acceptés avec leur statut de présence déjà résolu côté SQL ; `GET /api/friends/requests` liste les demandes reçues en attente ; `GET /api/friends/search?q=` cherche par pseudo (sous-chaîne, ≥2 caractères), renvoie aussi `steam_id` (via `linked_accounts`) pour le croisement côté client.
- **Présence** (`users.last_heartbeat_at`/`in_game`, pas de table dédiée) : `POST /api/presence/heartbeat` (`{ inGame: bool }`), appelé périodiquement par le client tant qu'il est authentifié (menu ET bataille). Statut dérivé côté SQL dans `friendModel.getFriends` : hors ligne si pas de heartbeat depuis `ONLINE_WINDOW_SECONDS` (90s, tolère 1-2 battements manqués), sinon en jeu/en ligne selon `in_game`. Polling HTTP volontairement, pas de WebSocket (décision utilisateur — cohérent avec le matchmaking classé, pas de nouvelle brique d'infra côté VPS/Nginx, voir aussi P13 dans `E:\card-game\TODO.md`).
- **`messages`** (chat privé, réservé aux amis acceptés — vérifié dans `messageController.send` via `friendModel.findFriendship`) : `POST /api/messages` envoie, `GET /api/messages/:friendId?limit=&beforeId=` pagine l'historique (le plus récent en tête, `beforeId` = curseur pour remonter), `GET /api/messages/conversations` liste les conversations ayant au moins un message échangé (un ami jamais contacté n'y apparaît pas), la plus récente en tête, avec le compte de non-lus par conversation. `POST /api/messages/:friendId/read` marque une conversation comme lue. `GET /api/messages/unread-total` alimente le badge du bouton Chat du menu principal (rond rouge + nombre, voir demande utilisateur). Historique **conservé indéfiniment** (décision utilisateur, pas de purge).
- **Rien côté client `card-game` pour l'instant** (voir TODO.md P15) : ce backend est écrit en amont, l'intégration UI (panneau Amis, fenêtre de chat, menu contextuel clic droit, service de heartbeat) reste à faire.

### Matchmaking classé

Contrat d'origine : `E:\card-game\docs\backend-contracts\ranked-matchmaking-and-retention.md`, section 1. Le multijoueur reste un relais de commandes P2P Steam (pas de serveur de jeu autoritaire) : le backend ne fait qu'apparier deux tickets et désigner un hôte, la partie elle-même se joue en direct entre les deux clients comme n'importe quelle « Partie rapide ».

Table `matchmaking_tickets` (`matchmakingModel.ts`) : **un seul ticket actif par joueur** (`UNIQUE KEY` sur `user_id`), un nouvel appel à `joinQueue` remplace le précédent plutôt que d'en empiler un second (`INSERT ... ON DUPLICATE KEY UPDATE`, réinitialise `created_at`). Pas de job planifié séparé pour l'appariement : `joinQueue` et `getQueueStatus` (à chaque poll client, toutes les 2s côté `NetLobby.gd`) tentent chacun un appariement immédiat parmi les tickets `waiting`, verrouillés `FOR UPDATE` le temps de la transaction pour qu'un même adversaire ne soit jamais apparié deux fois par des requêtes concurrentes. Fenêtre de tolérance MMR élargie progressivement (±100 au départ, +50 toutes les 15s, plafond ±500) — la fenêtre retenue entre deux tickets est la plus large des deux côtés, pour qu'un joueur qui attend depuis longtemps élargisse effectivement ses chances. Un ticket `waiting` sans appariement après 5 min passe `expired` (le client abandonne de son côté après 3 min, `RANKED_QUEUE_TIMEOUT`, donc cette valeur n'est jamais le facteur limitant en pratique).

Hôte désigné de façon déterministe (le plus petit `user_id` des deux) au moment de l'appariement — jamais recalculé ensuite. L'hôte crée son lobby Steam puis appelle `POST /api/matchmaking/queue/:ticketId/report-lobby` (`{ steamLobbyId }`) : `reportLobby` propage ce `steam_lobby_id` sur **les deux** tickets (le sien et celui de l'adversaire, retrouvé via `opponent_id`) en une transaction, refuse (`403`) si l'appelant n'est pas le `role: "host"` confirmé de ce ticket. Le client invité relit ce `steam_lobby_id` à son prochain `GET /api/matchmaking/queue/:ticketId` et rejoint directement ce lobby. `DELETE /api/matchmaking/queue/:ticketId` (annulation) est idempotent par construction : ne touche qu'un ticket encore `waiting` appartenant à l'appelant, un ticket déjà consommé/expiré/absent ne renvoie jamais d'erreur.

MMR lu depuis `ranked_stats.mmr` (`rankedModel.getStats`, jamais envoyé par le client) au moment de rejoindre la file — pas de recalcul en cours d'attente. Une fois la partie terminée, `POST /api/ranked/matches/report` (déjà existant) crédite le MMR normalement : aucun champ ne distingue aujourd'hui un match classé d'une partie rapide côté backend, `Battle.is_ranked_match` reste un flag purement client (voir « Ranked / paliers » dans `E:\card-game\CLAUDE.md`).

**Jeton de session de match (anti-triche, TODO.md P9 côté `card-game`)** : `matchmakingModel.pairTickets` émet désormais, au moment même où deux tickets sont appariés, un JWT dédié (`helper/matchSessionToken.ts`, scope `match_session`, TTL 30 min, distinct du JWT d'auth — même secret `TOKEN_SECRET` mais payload/scope différents pour qu'un token ne soit jamais accepté à la place de l'autre) contenant un `matchId` généré serveur (`randomUUID()`, indépendant du `clientMatchId` du handshake réseau) et les deux `user_id` de la paire. Les deux tickets reçoivent le même `match_id`/`match_session_token` (colonnes ajoutées à `matchmaking_tickets`), relus par chaque client à son prochain poll (`GET /api/matchmaking/queue/:ticketId` → `toStatusResult`). `POST /api/ranked/matches/report` (`rankedController.reportMatch`) vérifie ce jeton (`verifyMatchSessionToken`, `matchId` du jeton doit égaler le `clientMatchId` déclaré, `playerAId`/`playerBId` doivent correspondre à `userId`/`opponentId` dans n'importe quel ordre) : preuve qu'un vrai appariement classé a eu lieu entre CES deux joueurs, contrairement à un `clientMatchId` purement auto-déclaré.

Rollout en deux temps pour ne pas casser le classé pour la version de `card-game` déjà en prod (qui n'envoie pas encore ce jeton) : `ENFORCE_MATCH_SESSION_TOKEN` (`.env`, défaut `false`) ne fait que journaliser (`console.warn`) un rapport sans jeton valide tant qu'il vaut `false` (soft mode) ; ne le passer à `true` qu'une fois le client mis à jour (transmission du jeton reçu au matchmaking jusqu'au rapport de fin de match) confirmé déployé. Ne couvre que le classé (seul flux avec un appariement backend réel) — `POST /api/rewards/solo-match` (vs IA, aucun adversaire réseau à apparier) reste seulement borné en valeurs, pas vérifiable par ce mécanisme.

### Niveau de compte (XP)

`levelModel.ts` — remplace complètement l'ancien barème d'or par match classé (`WIN_STREAK_REWARD_TIERS`, retiré de `rankedModel.ts`). Colonnes `users.level`/`users.xp` (voir `schema.sql`/`sync.ts`). Un match réseau (classé ou partie rapide, `rankedController.reportMatch` → `rankedModel.confirmMatch`) crédite le vainqueur via `winXpForStreak(newStreak)` (base `XP_WIN_NETWORK` = 50, voir multiplicateur de série ci-dessous) et le perdant via `XP_LOSS_NETWORK` (15), dans la même transaction que la mise à jour du MMR (`levelModel.applyXp`, appelée avec la connexion déjà ouverte — pas `addXp`, réservée aux appelants sans transaction en cours). Le solo (vs IA) ne rapporte pas d'XP, comme il ne rapporte déjà plus d'or depuis 2026-08-26.

**Multiplicateur de série de victoires** : `winXpForStreak` applique un multiplicateur à `XP_WIN_NETWORK` selon `ranked_stats.win_streak` (déjà incrémentée par `confirmMatch` avant l'appel) — série ≥7 → ×1,75, ≥5 → ×1,5, ≥3 → ×1,25, sinon ×1 (`WIN_STREAK_XP_MULTIPLIER_TIERS`, arrondi au plus proche). Jamais appliqué à la défaite (la série retombe à 0). Remplace l'ancien barème d'or par palier sur le même principe, mais agit sur l'XP plutôt que sur l'or directement.

XP requise pour passer du niveau `n` à `n+1` : `xpToReachNextLevel(n)` croît **linéairement**, `100 + 5×n` (105 XP au niveau 1, 110 au niveau 2, 115 au niveau 3...) — calcul direct indépendant du seuil précédent, pas de dérive d'arrondi possible. Récompense à chaque niveau franchi (`rewardKindForLevel`, un seul niveau peut normalement être franchi par match, mais `applyXp` boucle pour en gérer plusieurs si jamais l'XP par match grandissait) :
- multiple de 25 → 1 pack gratuit (`currencyModel.creditFreePacks`, même solde que les quêtes hebdo/parrainage) **+ 200 or** (`GOLD_BONUS_PER_PACK_LEVEL`) ;
- sinon multiple de 5 → une carte aléatoire d'une rareté qui cycle sur 20 niveaux (5→Commune, 10→Rare, 15→Épique, 20/40/60...→Légendaire) **+ 100 or** (`GOLD_BONUS_PER_CARD_LEVEL`, cumulé avec un éventuel dust si le joueur possède déjà `MAX_COPIES_PER_CARD` exemplaires — même logique de dust que `packModel.drawAndGrantCards`) ; si aucune carte de cette rareté n'existe en base, le bonus de 100 or remplace entièrement la récompense (type `"gold"`) ;
- sinon → or croissant sur une série de 4 niveaux, 25/50/75/100 (`goldRewardForLevel`, lu directement sur `level % 5` ∈ {1,2,3,4} — ces niveaux tombent toujours par groupes de 4 entre deux paliers carte/pack, donc jamais besoin de mémoriser où on en est dans la série), qui retombe à 25 dès le niveau suivant un palier carte ou pack.

Le champ `gold` d'un `LevelReward` reflète toujours le montant total réellement crédité pour ce palier (bonus seul, bonus+dust, ou or fixe), jamais seulement une composante — `rankedController`/`LevelManager.gd` n'ont qu'à l'afficher tel quel.

`match_history.xp_awarded_player1`/`xp_awarded_player2` journalisent l'XP brute accordée à CE match (pas l'état de niveau, qui continue d'évoluer) : sert à `rankedController.reportMatch` à relire le montant exact sur un rapport rejoué après confirmation (retry réseau), `client_match_id` étant `UNIQUE` sur cette table — `confirmMatch` ne peut créditer l'XP qu'une seule fois par match. Niveau/XP exposés au client via `GET /api/profile` (`profileModel.getProfile` → champ `level`, consommé par le panneau profil et le badge persistant côté `MainMenu.gd`) plutôt qu'une route dédiée.

**Popup de récompenses de niveau (table `level_rewards`)** : l'octroi (crédit d'or/carte/pack) reste immédiat et automatique dans `grantLevelReward`, comme ci-dessus — `level_rewards` (une ligne par `user_id`+`level` réellement franchi, `logLevelReward`) ne fait que le journaliser pour que le client puisse le parcourir plus tard, la carte précise obtenue n'étant jamais stockée (déterministe depuis le niveau via `rewardKindForLevel`, et de toute façon jamais affichée — même convention que `GameOverScreen.show_xp_reward` côté client, qui ne montre que la rareté). `GET /api/level/rewards` (`levelController.getMyLevelRewards`) renvoie `{ level, catalog, rewards }` : `catalog` est le tableau déterministe (`levelModel.getRewardCatalog`, aucune requête DB) des récompenses par niveau jusqu'à `max(60, level + 10)` — sert à afficher aussi les niveaux pas encore atteints ; `rewards` ne contient que les lignes réellement journalisées pour ce joueur (`getUserRewards`), avec un booléen `claimed` dérivé de `claimed_at`. `POST /api/level/rewards/claim` (`{ levels: number[] }`) marque `claimed_at = NOW()` sur les lignes correspondantes encore non réclamées (`claimRewards`) — un simple accusé de réception côté joueur, ne déclenche **aucun** nouveau crédit ; ignore silencieusement les niveaux invalides ou déjà réclamés. Un niveau franchi avant l'introduction de cette table (2026-09) n'a pas de ligne : le client le traite comme acquis sans rien à réclamer.

### Quêtes quotidiennes

Table `daily_quests` (une ligne par joueur/jour/slot, 2 slots) — le **contenu** des quêtes (`QUEST_TEMPLATES`) vit en code dans `questModel.ts`, pas en base : seule l'assignation/progression par joueur y est stockée. Assignation paresseuse au premier appel du jour (`ensureTodayQuests`, même pattern que `rankedModel.getStats`/`solo_stats`), rotation déterministe par `userId + jour` (pas de RNG stocké, le même couple de quêtes est recalculable sans lire la base).

Progression branchée directement dans les points d'entrée de fin de match existants plutôt que via un nouvel endpoint de télémétrie : `rewardsController.reportSoloMatch` (mode `"solo"`) et `rankedController.reportMatch` une fois `confirmMatch` réussi (mode `"ranked"`, les deux joueurs progressent avec leur propre résultat gagnant/perdant). Trois objectifs pour l'instant, tous dérivables de ces données déjà disponibles côté serveur (aucun nouveau champ envoyé par le client) : `play` (toute partie terminée), `win` (victoire, tout mode), `win_ranked` (victoire classée). `GET /api/quests/daily` / `POST /api/quests/:id/claim` (réclamation verrouillée par `FOR UPDATE`, même garde-fou anti-double-clic que `currencyModel.debit`).

Volontairement pas encore fait : objectifs par race/nombre de cartes jouées (demanderait une nouvelle télémétrie côté client `card-game`, non ajoutée pour garder ce premier jet sans changement client). Contrat détaillé à l'origine de cette feature : `E:\card-game\docs\backend-contracts\ranked-matchmaking-and-retention.md` (implémentation finale simplifiée par rapport à ce document — pas de nouvel endpoint `/api/matches/summary`, réutilisation des endpoints de fin de match existants).

### Récompense de connexion quotidienne

Table `login_rewards` (une ligne par joueur : `streak_day` + `last_claimed_date`). Pas de job planifié : `claimed_today`/`is_consecutive` sont calculés à la volée via `CURDATE()` côté SQL (jamais en comparant des dates côté app, pour éviter tout écart de fuseau horaire) — voir `loginRewardModel.fetchRow`. Récompense croissante sur 7 jours (`REWARD_BY_DAY`, 10 à 60 monnaie molle), qui boucle après le jour 7 plutôt que de plafonner ; `streak_day` en base continue lui de compter la série réelle sans plafond. Un jour manqué (dernière réclamation avant-hier ou plus tôt) reramène directement au palier 1. `GET /api/login-reward/status` (lecture seule, ne mute rien), `POST /api/login-reward/claim` (verrouillé `FOR UPDATE`, même garde-fou anti-double-réclamation que `currencyModel.debit`/`questModel.claimQuest`).

`GET /api/login-reward/status` renvoie aussi `upcoming` (`loginRewardModel.getUpcomingRewards`, pure/déterministe) : les `UPCOMING_REWARDS_COUNT` (5) prochains jours à partir de `streak_day` inclus, `[{day, reward}]`, pour la frise de la popup client (voir « Récompense de connexion quotidienne » dans le `CLAUDE.md` de `card-game`). Calculé et renvoyé par le serveur à chaque appel plutôt que dupliqué côté client (`REWARD_BY_DAY`) : élimine le risque de dérive silencieuse entre les deux copies de la table de récompenses qu'aurait posé un hardcodage client — le client se contente d'afficher ce tableau tel quel.

### Quêtes hebdomadaires & parrainage

Contrat d'origine (côté client, écrit avant implémentation) : `E:\card-game\docs\backend-contracts\weekly-quests-and-referral.md`.

**Quêtes hebdomadaires** : même principe que les quotidiennes (`weeklyQuestModel.ts`, `WEEKLY_QUEST_TEMPLATES` en code, table `weekly_quests` ne stocke que l'assignation/progression), mais un seul slot, reset chaque lundi (`week_start` calculé côté SQL via `WEEKDAY(CURDATE())`, jamais en JS, pour rester cohérent quel que soit le fuseau serveur) et récompense en **packs à ouvrir** (`reward_pack`, colonne `users.free_packs`) plutôt qu'en or. Branchée dans les mêmes points d'entrée que les quêtes quotidiennes (`rewardsController.reportSoloMatch`, `rankedController.reportMatch`), aucune nouvelle télémétrie. Objectif `win_network` : compte toute victoire en match réseau (`mode === "ranked"`, valeur transmise pour **tout** match réseau — classé ou partie rapide, voir `rankedController.reportMatch` qui ne les distingue pas) — volontairement pas d'objectif "vraiment classé uniquement", impossible à honorer avec les données actuelles. Objectif `play_multirace` : toute partie jouée (peu importe le résultat) avec un deck contenant au moins 2 races différentes (`deckRaces.length >= 2`). `GET /api/quests/weekly` / `POST /api/quests/weekly/:id/claim` (verrouillé `FOR UPDATE`, même garde-fou que `claimQuest`).

**Solde de packs gratuits** (`users.free_packs`, `currencyModel.getFreePacks`/`creditFreePacks`/`debitFreePack`) : alimenté par les quêtes hebdo et le parrainage, consommé par `POST /api/packs/open-owned` (`packModel.openOwnedPack`, mêmes probabilités de tirage que `openPack`, juste une source de débit différente — logique de tirage/octroi factorisée dans `drawAndGrantCards`). Exposé en lecture via `GET /api/currency/balance` (`free_packs` ajouté à côté de `balance`). Pas de ledger dédié comme `currency_ledger` : une seule source de valeur, pas d'audit fin nécessaire pour l'instant.

### Quêtes mensuelles

Table `monthly_quests` (`monthlyQuestModel.ts`, `MONTHLY_QUEST_TEMPLATES` en code) : même principe que les hebdomadaires (rotation par slot, reset périodique — `month_start` = 1er du mois courant calculé côté SQL via `DATE_FORMAT(CURDATE(), '%Y-%m-01')`, jamais en JS), mais objectifs nettement plus longs (ex. 100 parties multijoueur, 60 cartes d'une race). Récompense **double** comme les quêtes uniques (`reward_currency` **et** `reward_pack`, jusqu'à 1000 or + 4 packs par quête) plutôt qu'un seul type de solde, pour marquer le coup une fois par mois.

**3 slots par mois**, pas seulement `QUESTS_PER_MONTH` (2) : les slots `0`/`1` sont tirés au sort dans `MONTHLY_QUEST_TEMPLATES` (`play_network`/`win_network`/`play_race`/`play_multirace` — tous multijoueur ou par race, aucun objectif "toute partie confondue" côté rotation) ; le slot fixe `LOGIN_STREAK_SLOT` (= `QUESTS_PER_MONTH`) n'est **jamais** tiré au sort et porte toujours `LOGIN_STREAK_TEMPLATE` (`login_streak_30`, objectif `login`, 1000 or + 4 packs — la plus grosse récompense du mois, garantie chaque mois pour inciter à se connecter tous les jours). `ensureThisMonthQuests` upsert les 3 slots à chaque appel (idempotent via `ON DUPLICATE KEY UPDATE user_id = user_id`, ne réinitialise jamais une progression existante).

Objectif `login` alimenté par `progressForLogin(userId)`, appelé (fire-and-forget, comme `recordLogin`/`ensureAdminFromEnv`) depuis `authController.loginWithSteamId` — donc à **chaque connexion réussie**, jeu ou site. Colonne `monthly_quests.last_progress_date` (DATE, NULL par défaut) sert de verrou anti-double-compte le même jour : la condition `WHERE ... AND (last_progress_date IS NULL OR last_progress_date <> CURDATE())` dans l'`UPDATE` rend l'incrément naturellement idempotent quel que soit le nombre de connexions ce jour-là, sans transaction ni verrou explicite. Inutilisée pour les autres objectifs (toujours `NULL`).

Objectifs `play_network`/`win_network` réutilisent le mode `"ranked"` déjà transmis à `progressForMatch` pour **tout** match multijoueur (classé ou partie rapide — même convention que `weeklyQuestModel.win_network`) : `play_network` progresse sur toute partie réseau peu importe le résultat, `win_network` uniquement sur une victoire réseau. Branchée dans les mêmes points d'entrée que les quotidiennes/hebdo (`rewardsController.reportSoloMatch`, `rankedController.reportMatch`), aucune nouvelle télémétrie pour ces deux objectifs. `GET /api/quests/monthly` / `POST /api/quests/monthly/:id/claim` (verrouillé `FOR UPDATE`, même garde-fou que `claimQuest`).

### Quêtes uniques

Table `unique_quests` (`uniqueQuestModel.ts`, `UNIQUE_QUEST_TEMPLATES` en code) : contrairement aux quotidiennes/hebdo, **une seule ligne par joueur et par `quest_code`**, assignée une fois pour toutes (`ensureUniqueQuests`, paresseux comme les autres) puis **jamais reset** — pas de notion de slot/rotation, `GET /api/quests/unique` renvoie systématiquement le catalogue entier (15 quêtes) avec la progression de chacune. Objectifs longs, récompenses nettement plus généreuses que le quotidien/hebdo (jusqu'à 1200 or ou plusieurs packs) : conçues comme des jalons de carrière plutôt que des tâches répétées.

Objectifs couverts : `play`/`win`/`win_ranked` (paliers cumulés, ex. 50/200 parties jouées, 25/100 victoires), `play_race_first` (une par race implémentée — première partie, gagnée ou perdue, avec un deck contenant au moins une carte de cette race), `win_multirace_first` (première victoire avec un deck d'au moins 2 races), `win_all_races` (une victoire avec chacune des 4 races — le champ `meta` de la ligne stocke la liste des races déjà gagnantes, ex. `"Human,Demon"`, pour ne compter chaque race qu'une fois), `open_packs` (packs ouverts, payants ou gratuits confondus, hook dans `packModel.openPack`/`openOwnedPack`) et `reach_tier` (palier Or/Légende — seuils de MMR dupliqués depuis `RankTier.THRESHOLDS` côté client dans `RANK_TIER_MMR_THRESHOLDS`, calculés côté serveur à partir du MMR post-match renvoyé par `rankedModel.confirmMatch`, jamais déclarés par le client).

Branchée dans les mêmes points d'entrée que les quotidiennes/hebdo (`rewardsController.reportSoloMatch`, `rankedController.reportMatch`), plus deux points d'entrée propres : `packModel` (après tirage des cartes d'un pack, `progressForPackOpen`) et `rankedController.reportMatch` (après mise à jour du MMR, `progressForRankTier` — `rankedModel.confirmMatch` renvoie désormais aussi `ratingA`/`ratingB`, les MMR post-match des deux joueurs). `GET /api/quests/unique` / `POST /api/quests/unique/:id/claim` (verrouillé `FOR UPDATE`, même garde-fou que `claimQuest`) ; une quête peut porter une récompense en or, en packs, ou (rarement) les deux — `claimUniqueQuest` crédite chaque solde non nul.

**Parrainage** (`referralModel.ts`, table `referrals`) : un joueur ne peut parrainer qu'**un seul** ami — `referrer_id UNIQUE` posé en contrainte de schéma plutôt qu'en logique applicative, pour ne jamais pouvoir être contourné par une course entre requêtes concurrentes. `referred_id UNIQUE` (NULL autorisé tant que non utilisé) empêche symétriquement qu'un compte soit parrainé deux fois, par qui que ce soit. `GET /api/referral/code` génère le code paresseusement (8 caractères, alphabet sans caractères ambigus 0/O/1/I) ; `GET /api/referral/status` ; `POST /api/referral/redeem` (appelé par le **filleul**) valide le code puis pose `referred_id`/`redeemed_at`. La récompense (3 packs + 500 or, `REFERRAL_REWARD_PACKS`/`REFERRAL_REWARD_GOLD`) est créditée au **parrain**, pas au filleul, et déclenchée par la fin du tutoriel du filleul — pas de nouvelle route dédiée : `collectionController.claimStarter` appelle `referralModel.completeReferralIfPending` dans la même transaction que le reste de claim-starter (idempotent via `reward_granted_at`). Cas particulier géré : un code entré *après* que le filleul a déjà fini son tutoriel (`users.starter_claimed_at` déjà posé) déclenche la récompense immédiatement dans `redeemCode`, plutôt que d'attendre un `claim-starter` qui ne sera jamais rappelé pour ce compte.

## Tests automatisés

Framework : **Vitest**. Lancer toute la suite : `cd backend && npm run test` (`vitest run`). ~25 fichiers `*.test.ts` couvrant controllers/models/helpers (auth, decks, packs, quêtes, ranked, parrainage, récompense de connexion, contact, helper Elo, JWT, helpers Steam...). Toute nouvelle route ou logique métier non triviale mérite un test, en suivant le pattern déjà en place (test du controller/model concerné, pas de test d'intégration HTTP bout-en-bout).

## Déploiement / Infra (VPS)

Depuis le 2026-07-29, le backend tourne en prod sur un **VPS OVH** (`137.74.163.226`, Ubuntu, `api.wyrdane.com`) — plus sur Render (service Render conservé temporairement en secours, à couper une fois la prod VPS confirmée stable). Le site compagnon `wyrdane-website` (`wyrdane.com`) est hébergé sur le **même VPS**. Procédure d'installation complète (DNS, setup serveur, bugs rencontrés) : `C:\Users\ninou\Desktop\Wyrdane\Info\recap-deploiement-vps-wyrdane.md`.

### Stack sur le VPS
- **Utilisateur `deploy`** : pas de mot de passe (auth SSH par clé uniquement), dans les groupes `sudo` (mais sudo impossible sans mot de passe — toute commande root passe par le compte `ubuntu`) et `docker`.
- **Backend** : Docker Compose (`docker-compose.yml` à la racine du repo, cloné dans `/var/www/wyrdane-backend`) — service `mysql` (MySQL 8, volume persistant, exposé uniquement sur `127.0.0.1:3306`) + service `backend` (build depuis `backend/Dockerfile`, exposé sur `127.0.0.1:3000`). Le `.env` réel (secrets DB, `TOKEN_SECRET`, `STEAM_WEB_API_KEY`...) vit uniquement sur le VPS, jamais commité, permissions `600`.
- **Reverse proxy** : Nginx natif (hors Docker) fait le proxy HTTPS → `127.0.0.1:3000`, config dans `/etc/nginx/sites-available/api.wyrdane.com`. Certificats **Let's Encrypt** via Certbot (`certbot.timer` gère le renouvellement auto).
- **Sécurité** : pare-feu `ufw` actif (seuls 22/80/443 ouverts en entrée, tout le reste deny par défaut, MySQL explicitement bloqué en externe), `fail2ban` installé et actif (jail `sshd`, ban après 5 échecs/10min), `unattended-upgrades` actif pour les patchs de sécurité auto, SSH en clé uniquement (`PasswordAuthentication no`).

### Déploiement continu (CI/CD)
Un script `deploy-backend.sh` (à la racine du repo, sur le VPS) fait `git pull origin main && docker compose up -d --build`. Le workflow GitHub Actions `.github/workflows/deploy.yml` (action `appleboy/ssh-action`) se connecte en SSH au VPS et lance ce script à chaque push sur `main` — **tout push sur `main` redéploie automatiquement la prod**, aucune action manuelle nécessaire. Secrets du repo GitHub : `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (clé dédiée `wyrdane-ci-deploy`, ed25519 sans passphrase, distincte des clés personnelles).

Pour toute intervention manuelle ponctuelle sur le VPS nécessitant un accès SSH temporaire (pas de clé permanente disponible en session agent — les clés `~/.ssh/id_ed25519`/`wyrdane_vps` sont protégées par une passphrase que l'agent n'a pas) : générer une clé ed25519 temporaire sans passphrase, demander à l'utilisateur de l'ajouter lui-même aux `authorized_keys` du compte `deploy` (tâches courantes) ou `ubuntu` (tâches nécessitant sudo), puis la retirer des `authorized_keys` distants et la supprimer localement une fois le travail terminé. `deploy` suffit pour toute commande `docker compose ...` (groupe `docker`) — `ubuntu` n'est nécessaire que pour du vrai root.

### Appliquer un changement de schéma en prod (après un ajout de table)

`npm run db:sync` (voir `backend/src/database/sync.ts`) ne fonctionne **qu'en dev**, jamais tel quel dans le conteneur de prod : ce script utilise `tsx` pour exécuter `src/database/sync.ts` directement, or `tsx` est une devDependency absente de l'image de prod (`Dockerfile`, `npm ci --omit=dev`). La bonne commande en conteneur est le JS déjà compilé par `tsc` au build :

```bash
cd /var/www/wyrdane-backend
docker compose exec backend node dist/database/sync.js
```

(`db:migrate`/`dist/database/migrate.js` de la même façon, mais c'est une commande destructive réservée au dev/CI — jamais contre la base de prod.)

### `keep-alive.yml` obsolète
`.github/workflows/keep-alive.yml` (ping périodique de l'URL Render pour éviter la mise en veille du plan gratuit) est devenu obsolète depuis le passage au VPS — à supprimer une fois le service Render définitivement coupé.

## Conventions de code

- TypeScript strict, pattern `router → controller → model` déjà en place à respecter pour toute nouvelle feature (pas de logique SQL dans les controllers, pas de logique HTTP dans les modèles)
- Rester cohérent avec les patterns déjà en place (validation Joi, gestion d'erreurs try/catch avec `console.error` + réponse 500 générique) plutôt que d'introduire de nouvelles conventions

## Workflow Git

Même convention que `E:\card-game` : noms de branches et messages de commit **toujours en anglais**, même si le contenu du jeu/documentation reste en français.

- Branches : format `NNNN-slug` (numéro séquentiel sur 4 chiffres + court descriptif en kebab-case anglais)
- Commits : anglais, format court (`feat: add ranked ladder table`)
- Ne jamais committer directement sur la branche principale
