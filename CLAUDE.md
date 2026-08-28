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
│   ├── middleware/         # auth.ts : vérifie le cookie JWT avant les routes protégées
│   ├── helper/               # steamHelper (vérif ticket Steam), jwtHelper (encode/decode)
│   ├── validator/            # Validation Joi des payloads (decks, cartes)
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

Déjà en place : auth Steam, gestion des decks (CRUD), catalogue de cartes, collection persistante + monnaie molle + boutique de packs, classement ranked (MMR Elo, double-report de match, leaderboard), boutique de cosmétiques (ledger d'achats Steamworks Microtransactions), quêtes quotidiennes (voir « Quêtes quotidiennes » ci-dessous), récompense de connexion quotidienne (voir « Récompense de connexion quotidienne » ci-dessous), quêtes hebdomadaires et parrainage à sens unique (voir « Quêtes hebdomadaires & parrainage » ci-dessous).

### Quêtes quotidiennes

Table `daily_quests` (une ligne par joueur/jour/slot, 3 slots) — le **contenu** des quêtes (`QUEST_TEMPLATES`) vit en code dans `questModel.ts`, pas en base : seule l'assignation/progression par joueur y est stockée. Assignation paresseuse au premier appel du jour (`ensureTodayQuests`, même pattern que `rankedModel.getStats`/`solo_stats`), rotation déterministe par `userId + jour` (pas de RNG stocké, le même triplet de quêtes est recalculable sans lire la base).

Progression branchée directement dans les points d'entrée de fin de match existants plutôt que via un nouvel endpoint de télémétrie : `rewardsController.reportSoloMatch` (mode `"solo"`) et `rankedController.reportMatch` une fois `confirmMatch` réussi (mode `"ranked"`, les deux joueurs progressent avec leur propre résultat gagnant/perdant). Trois objectifs pour l'instant, tous dérivables de ces données déjà disponibles côté serveur (aucun nouveau champ envoyé par le client) : `play` (toute partie terminée), `win` (victoire, tout mode), `win_ranked` (victoire classée). `GET /api/quests/daily` / `POST /api/quests/:id/claim` (réclamation verrouillée par `FOR UPDATE`, même garde-fou anti-double-clic que `currencyModel.debit`).

Volontairement pas encore fait : objectifs par race/nombre de cartes jouées (demanderait une nouvelle télémétrie côté client `card-game`, non ajoutée pour garder ce premier jet sans changement client). Contrat détaillé à l'origine de cette feature : `E:\card-game\docs\backend-contracts\ranked-matchmaking-and-retention.md` (implémentation finale simplifiée par rapport à ce document — pas de nouvel endpoint `/api/matches/summary`, réutilisation des endpoints de fin de match existants).

### Récompense de connexion quotidienne

Table `login_rewards` (une ligne par joueur : `streak_day` + `last_claimed_date`). Pas de job planifié : `claimed_today`/`is_consecutive` sont calculés à la volée via `CURDATE()` côté SQL (jamais en comparant des dates côté app, pour éviter tout écart de fuseau horaire) — voir `loginRewardModel.fetchRow`. Récompense croissante sur 7 jours (`REWARD_BY_DAY`, 10 à 60 monnaie molle), qui boucle après le jour 7 plutôt que de plafonner ; `streak_day` en base continue lui de compter la série réelle sans plafond. Un jour manqué (dernière réclamation avant-hier ou plus tôt) reramène directement au palier 1. `GET /api/login-reward/status` (lecture seule, ne mute rien), `POST /api/login-reward/claim` (verrouillé `FOR UPDATE`, même garde-fou anti-double-réclamation que `currencyModel.debit`/`questModel.claimQuest`).

### Quêtes hebdomadaires & parrainage

Contrat d'origine (côté client, écrit avant implémentation) : `E:\card-game\docs\backend-contracts\weekly-quests-and-referral.md`.

**Quêtes hebdomadaires** : même principe que les quotidiennes (`weeklyQuestModel.ts`, `WEEKLY_QUEST_TEMPLATES` en code, table `weekly_quests` ne stocke que l'assignation/progression), mais reset chaque lundi (`week_start` calculé côté SQL via `WEEKDAY(CURDATE())`, jamais en JS, pour rester cohérent quel que soit le fuseau serveur) et récompense en **packs à ouvrir** (`reward_pack`, colonne `users.free_packs`) plutôt qu'en or. Branchée dans les mêmes points d'entrée que les quêtes quotidiennes (`rewardsController.reportSoloMatch`, `rankedController.reportMatch`), aucune nouvelle télémétrie. Objectif `win_network` : compte toute victoire en match réseau (`mode === "ranked"`, valeur transmise pour **tout** match réseau — classé ou partie rapide, voir `rankedController.reportMatch` qui ne les distingue pas) — volontairement pas d'objectif "vraiment classé uniquement", impossible à honorer avec les données actuelles. `GET /api/quests/weekly` / `POST /api/quests/weekly/:id/claim` (verrouillé `FOR UPDATE`, même garde-fou que `claimQuest`).

**Solde de packs gratuits** (`users.free_packs`, `currencyModel.getFreePacks`/`creditFreePacks`/`debitFreePack`) : alimenté par les quêtes hebdo et le parrainage, consommé par `POST /api/packs/open-owned` (`packModel.openOwnedPack`, mêmes probabilités de tirage que `openPack`, juste une source de débit différente — logique de tirage/octroi factorisée dans `drawAndGrantCards`). Exposé en lecture via `GET /api/currency/balance` (`free_packs` ajouté à côté de `balance`). Pas de ledger dédié comme `currency_ledger` : une seule source de valeur, pas d'audit fin nécessaire pour l'instant.

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
