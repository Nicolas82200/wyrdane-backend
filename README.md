# Wyrdane — Backend

API partagée du TCG **Wyrdane**, consommée par le client de jeu (Godot 4, multijoueur Steam — voir le dépôt `card-game`) et par un site web compagnon de deck building.

## Rôle

- **Comptes joueurs** — authentification exclusivement via Steam (ticket de session vérifié côté serveur), pas de mot de passe
- **Decks** — création/modification/suppression des decks, consultable et modifiable depuis le site web comme depuis le jeu
- **Catalogue de cartes** — source de vérité des données de carte servies au site web
- À venir : **classement (ranked)**, **collection de cartes** (déblocages persistants), **boutique de cosmétiques** (achats réels)

## Stack

- Node.js / TypeScript / Express 5
- MySQL (`mysql2`)
- JWT en cookie httpOnly pour la session, identité vérifiée via l'API Web Steamworks

## Structure

```
backend/     → API REST (Express, MySQL, auth Steam)
```

## Prérequis

- Node.js ≥ 18
- MySQL ≥ 8
- Une clé Web API Steamworks (https://partner.steamgames.com) pour l'AppID du jeu

## Démarrage

```bash
cd backend
npm install
cp .env.sample .env   # puis renseigner DB_*, TOKEN_SECRET, STEAM_WEB_API_KEY, STEAM_APP_ID
npm run dev
```

Importer `backend/src/database/schema.sql` puis `cards_data.sql` dans la base MySQL avant le premier lancement.

## Origine

Ce backend est issu d'une copie du backend d'un projet de formation (deck builder MySQL/Express), adapté pour devenir le backend commun du jeu Wyrdane : authentification remplacée par Steam, schéma étendu pour la progression persistante (classement, collection, boutique).
