-- Contrepartie non destructive de schema.sql : à rejouer sans risque contre
-- une base déjà en service (aucun DROP, tout en CREATE TABLE IF NOT EXISTS).
-- Sert à rattraper un schéma de prod qui n'a jamais reçu les tables/colonnes
-- ajoutées après sa première initialisation via db:migrate (destructif,
-- jamais rejouable sans perdre les données existantes) — voir sync.ts pour
-- l'usage (npm run db:sync). Les colonnes ajoutées à une table existante
-- (users.soft_currency, etc.) sont gérées à part dans sync.ts : la syntaxe
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS n'est pas supportée par toutes les
-- versions de MySQL/MariaDB.

CREATE TABLE IF NOT EXISTS linked_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  provider VARCHAR(20) NOT NULL,
  external_id VARCHAR(191) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_provider_external (provider, external_id)
);

CREATE TABLE IF NOT EXISTS cards (
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

CREATE TABLE IF NOT EXISTS user_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  card_id INT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_card (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS decks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deck_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  deck_id INT NOT NULL,
  card_id INT NOT NULL,
  quantity INT DEFAULT 1,
  FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
  UNIQUE KEY unique_deck_card (deck_id, card_id)
);

CREATE TABLE IF NOT EXISTS ranked_stats (
  user_id INT PRIMARY KEY,
  mmr INT NOT NULL DEFAULT 1000,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  season INT NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS solo_stats (
  user_id INT PRIMARY KEY,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_rewards (
  user_id INT PRIMARY KEY,
  streak_day INT NOT NULL DEFAULT 0,
  last_claimed_date DATE NULL DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS match_history (
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

CREATE TABLE IF NOT EXISTS match_reports (
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

CREATE TABLE IF NOT EXISTS daily_quests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  quest_date DATE NOT NULL,
  slot TINYINT NOT NULL,
  quest_code VARCHAR(30) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  reward_currency INT NOT NULL,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_date_slot (user_id, quest_date, slot)
);

CREATE TABLE IF NOT EXISTS cosmetic_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  steam_item_id VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(30) NOT NULL,
  price_cents INT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_cosmetics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  item_id INT NOT NULL,
  acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES cosmetic_items(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_item (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS purchase_ledger (
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

CREATE TABLE IF NOT EXISTS currency_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount INT NOT NULL,
  reason VARCHAR(30) NOT NULL,
  reference VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_currency_ledger_user_reason_date (user_id, reason, created_at)
);

CREATE TABLE IF NOT EXISTS site_visits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visitor_id VARCHAR(64) NOT NULL,
  path VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_site_visits_visitor (visitor_id),
  INDEX idx_site_visits_created (created_at)
);

CREATE TABLE IF NOT EXISTS login_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  source VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_login_events_source_date (source, created_at)
);

CREATE TABLE IF NOT EXISTS wishlist_stats (
  id INT PRIMARY KEY DEFAULT 1,
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT IGNORE INTO wishlist_stats (id, count) VALUES (1, 0);
