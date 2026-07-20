DROP DATABASE IF EXISTS wyrdane_game;
CREATE DATABASE IF NOT EXISTS wyrdane_game CHARACTER SET utf8mb4;
USE wyrdane_game;

DROP TABLE IF EXISTS deck_cards;
DROP TABLE IF EXISTS decks;
DROP TABLE IF EXISTS user_cards;
DROP TABLE IF EXISTS match_reports;
DROP TABLE IF EXISTS match_history;
DROP TABLE IF EXISTS ranked_stats;
DROP TABLE IF EXISTS purchase_ledger;
DROP TABLE IF EXISTS user_cosmetics;
DROP TABLE IF EXISTS cosmetic_items;
DROP TABLE IF EXISTS currency_ledger;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS linked_accounts;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  soft_currency INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Rempli par POST /api/collection/claim-starter (fin de tutoriel) : évite de
  -- regrant/recréer les decks de départ si le joueur relance la réclamation.
  starter_claimed_at TIMESTAMP NULL DEFAULT NULL
);

-- Une ligne par identité liée (Steam aujourd'hui, potentiellement email/Google/Apple
-- plus tard pour un client mobile) sans jamais changer la clé primaire du joueur.
CREATE TABLE linked_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  provider VARCHAR(20) NOT NULL,
  external_id VARCHAR(191) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_provider_external (provider, external_id)
);

CREATE TABLE cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  race VARCHAR(20) NOT NULL,
  card_type VARCHAR(20) NOT NULL,
  lane VARCHAR(10),
  cost INT,
  attack INT,
  hp INT,
  rarity VARCHAR(20),
  charges INT,
  effect TEXT,
  flavor TEXT,
  image_path TEXT,
  INDEX idx_cards_type (card_type),
  INDEX idx_cards_race (race),
  INDEX idx_cards_rarity (rarity)
);

-- Cartes effectivement débloquées par un joueur (collection persistante).
-- Un deck ne peut utiliser que des cartes présentes ici, en quantité suffisante.
CREATE TABLE user_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  card_id INT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_card (user_id, card_id)
);

CREATE TABLE decks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE deck_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  deck_id INT NOT NULL,
  card_id INT NOT NULL,
  quantity INT DEFAULT 1,
  FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
  UNIQUE KEY unique_deck_card (deck_id, card_id)
);

CREATE TABLE ranked_stats (
  user_id INT PRIMARY KEY,
  mmr INT NOT NULL DEFAULT 1000,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  season INT NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Un match confirmé n'existe ici qu'une fois que les deux rapports (voir
-- match_reports) concordent sur le vainqueur.
CREATE TABLE match_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_match_id VARCHAR(100) NOT NULL UNIQUE,
  player1_id INT NOT NULL,
  player2_id INT NOT NULL,
  winner_id INT NOT NULL,
  season INT NOT NULL,
  played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player1_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (player2_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Un rapport par joueur et par match (client_match_id = identifiant généré
-- côté client, partagé par les deux joueurs d'une même partie P2P). Le match
-- n'est validé (cf match_history) que quand les deux rapports concordent.
CREATE TABLE match_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_match_id VARCHAR(100) NOT NULL,
  reporter_id INT NOT NULL,
  opponent_id INT NOT NULL,
  winner_id INT NOT NULL,
  season INT NOT NULL,
  reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (opponent_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_match_reporter (client_match_id, reporter_id)
);

CREATE TABLE cosmetic_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  steam_item_id VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(30) NOT NULL,
  price_cents INT NOT NULL
);

CREATE TABLE user_cosmetics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  item_id INT NOT NULL,
  acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES cosmetic_items(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_item (user_id, item_id)
);

-- order_id est choisi par nous (requis par InitTxn de l'API Steamworks
-- Microtransactions) ; steam_txn_id est le transid renvoyé par Steam.
CREATE TABLE purchase_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  item_id INT NOT NULL,
  order_id BIGINT NOT NULL UNIQUE,
  steam_txn_id VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES cosmetic_items(id) ON DELETE CASCADE
);

-- Mouvements de monnaie molle (gagnée en jouant, dépensée en packs) : sert à
-- la fois d'audit et de base au plafond quotidien des récompenses solo
-- (compter les lignes reason='match_win_solo' du jour pour un joueur donné).
-- users.soft_currency reste le solde dénormalisé pour une lecture rapide.
CREATE TABLE currency_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount INT NOT NULL,
  reason VARCHAR(30) NOT NULL,
  reference VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_currency_ledger_user_reason_date (user_id, reason, created_at)
);