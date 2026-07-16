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

1. Le client (jeu ou site web après un flow "Sign in through Steam" côté navigateur) obtient un ticket de session Steam.
2. `POST /api/auth/steam` avec `{ ticket }` → `steamHelper.authenticateSteamTicket()` interroge l'API Web Steamworks pour valider le ticket et récupérer le `steamid`.
3. Le backend cherche ce `steamid` dans `linked_accounts` (table qui associe un `user_id` interne à une identité externe : `provider` + `external_id`). S'il n'existe pas, un `user` et sa ligne `linked_accounts` sont créés en une transaction (`userModel.createWithSteamAccount`).
4. Un JWT `{ id, name }` est signé et posé en cookie httpOnly `auth_token` — identique à l'ancien flow email/mot de passe, seule l'étape de vérification d'identité a changé.

**Pourquoi `linked_accounts` plutôt qu'une colonne `steam_id` sur `users`** : ça garde la porte ouverte à d'autres providers (email, Google, Apple Sign-In) si un client mobile voit le jour un jour, sans avoir à migrer le schéma ni changer l'identifiant interne du joueur (`user_id`) qui porte déjà collection/decks/progression.

Variables d'environnement nécessaires (voir `.env.sample`) : `STEAM_WEB_API_KEY` et `STEAM_APP_ID` (clé Web API générée sur https://partner.steamgames.com pour l'AppID du jeu).

## Lancer le projet

```
cd backend
npm install
npm run dev          # tsx watch src/index.ts, port défini par PORT (.env)
```

- Importer `src/database/schema.sql` (puis `cards_data.sql`) dans une instance MySQL locale avant de lancer le serveur.
- Copier `.env.sample` en `.env` et renseigner les identifiants MySQL + `TOKEN_SECRET` + `STEAM_WEB_API_KEY`/`STEAM_APP_ID`.

## Roadmap (voir aussi la section correspondante dans `E:\card-game\CLAUDE.md`)

Le trigger pour l'existence de ce backend : trois features prévues côté jeu qui ont besoin d'un état serveur autoritatif :
- **Classement (ranked)** — MMR/leaderboard, ne doit pas être manipulable côté client
- **Collection de cartes** — déblocage progressif persistant par joueur (pas juste la bibliothèque complète)
- **Boutique de cosmétiques** — achats réels, l'API Steamworks Microtransactions exige un serveur pour finaliser chaque transaction (`FinalizeTxn`)

Déjà en place : auth Steam, gestion des decks (CRUD), catalogue de cartes.
À faire : tables/routes pour MMR, déblocages de collection, et ledger d'achats boutique.

## Conventions de code

- TypeScript strict, pattern `router → controller → model` déjà en place à respecter pour toute nouvelle feature (pas de logique SQL dans les controllers, pas de logique HTTP dans les modèles)
- Rester cohérent avec les patterns déjà en place (validation Joi, gestion d'erreurs try/catch avec `console.error` + réponse 500 générique) plutôt que d'introduire de nouvelles conventions

## Workflow Git

Même convention que `E:\card-game` : noms de branches et messages de commit **toujours en anglais**, même si le contenu du jeu/documentation reste en français.

- Branches : format `NNNN-slug` (numéro séquentiel sur 4 chiffres + court descriptif en kebab-case anglais)
- Commits : anglais, format court (`feat: add ranked ladder table`)
- Ne jamais committer directement sur la branche principale
