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
  mmr INT NOT NULL DEFAULT 0,
  hidden_mmr INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  win_streak INT NOT NULL DEFAULT 0,
  season INT NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS matchmaking_tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  mmr INT NOT NULL,
  mode VARCHAR(10) NOT NULL DEFAULT 'ranked',
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  opponent_id INT NULL,
  role VARCHAR(10) NULL,
  steam_lobby_id BIGINT NULL,
  match_id VARCHAR(36) NULL,
  match_session_token TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Dernier poll du propriétaire (GET /queue/:ticketId). Un ticket ne passe
  -- 'expired' que si son PROPRE joueur le poll, donc un joueur qui ferme le jeu
  -- laisserait sinon un ticket 'waiting' appariable indéfiniment : findOpponent
  -- n'accepte que les candidats vus récemment (voir matchmakingModel.ts).
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_ticket_id (ticket_id),
  UNIQUE KEY unique_user_ticket (user_id),
  INDEX idx_matchmaking_status (status)
);

CREATE TABLE IF NOT EXISTS solo_stats (
  user_id INT PRIMARY KEY,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  win_streak INT NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_rewards (
  user_id INT PRIMARY KEY,
  streak_day INT NOT NULL DEFAULT 0,
  last_claimed_date DATE NULL DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS level_rewards (
  user_id INT NOT NULL,
  level INT NOT NULL,
  type ENUM('card', 'pack', 'gold') NOT NULL,
  gold INT NOT NULL DEFAULT 0,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (user_id, level),
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
  xp_awarded_player1 INT NOT NULL DEFAULT 0,
  xp_awarded_player2 INT NOT NULL DEFAULT 0,
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
  mode VARCHAR(10) NOT NULL DEFAULT 'ranked',
  season INT NOT NULL,
  cards_played_by_race JSON NULL,
  resource_cards_by_race JSON NULL,
  deck_races JSON NULL,
  cards_played JSON NULL,
  reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (opponent_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_match_reporter (client_match_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS card_play_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  card_name VARCHAR(150) NOT NULL,
  client_match_id VARCHAR(100) NOT NULL,
  user_id INT NOT NULL,
  won BOOLEAN NOT NULL,
  season INT NOT NULL,
  played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_card_match_user (card_name, client_match_id, user_id),
  INDEX idx_card_play_stats_card_name (card_name)
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
  reward_xp INT NOT NULL DEFAULT 0,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_date_slot (user_id, quest_date, slot)
);

CREATE TABLE IF NOT EXISTS weekly_quests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  week_start DATE NOT NULL,
  slot TINYINT NOT NULL,
  quest_code VARCHAR(30) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  reward_pack INT NOT NULL,
  reward_currency INT NOT NULL DEFAULT 0,
  reward_xp INT NOT NULL DEFAULT 0,
  -- Jours de connexion distincts déjà comptés, pour la quête « connectez-vous
  -- 7 jours » : sans ça, deux connexions le même jour compteraient deux fois.
  last_progress_date DATE NULL DEFAULT NULL,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_week_slot (user_id, week_start, slot)
);

CREATE TABLE IF NOT EXISTS monthly_quests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  month_start DATE NOT NULL,
  slot TINYINT NOT NULL,
  quest_code VARCHAR(30) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  reward_currency INT NOT NULL DEFAULT 0,
  reward_pack INT NOT NULL DEFAULT 0,
  reward_xp INT NOT NULL DEFAULT 0,
  -- Nom de race dont un pack est offert en plus de reward_pack (multirace),
  -- ou le littéral "all" pour un pack de CHACUNE des races implémentées.
  reward_pack_race VARCHAR(20) NULL DEFAULT NULL,
  -- Progression par race, pour la quête « 100 cartes de chaque race » : un
  -- compteur unique ne saurait pas distinguer 400 cartes d'une seule race.
  meta JSON NULL,
  last_progress_date DATE NULL DEFAULT NULL,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_month_slot (user_id, month_start, slot)
);

CREATE TABLE IF NOT EXISTS unique_quests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  quest_code VARCHAR(40) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  reward_currency INT NOT NULL DEFAULT 0,
  reward_pack INT NOT NULL DEFAULT 0,
  meta VARCHAR(100) NULL,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_code (user_id, quest_code)
);

CREATE TABLE IF NOT EXISTS onboarding_quests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  quest_code VARCHAR(40) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  reward_currency INT NOT NULL DEFAULT 0,
  reward_pack INT NOT NULL DEFAULT 0,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_code (user_id, quest_code)
);

CREATE TABLE IF NOT EXISTS referrals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  referrer_id INT NOT NULL UNIQUE,
  code VARCHAR(12) NOT NULL UNIQUE,
  referred_id INT NULL UNIQUE,
  redeemed_at TIMESTAMP NULL DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  reward_granted_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE
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

-- Prix par devise, pour les devises AUTRES QUE L'EURO. L'euro reste porté par
-- `cosmetic_items.price_cents` : une seule source par devise, donc aucune
-- paire de valeurs à tenir d'accord (ce projet s'est déjà fait prendre trois
-- fois par une copie manuelle divergente). `shopModel.resolvePrice` applique
-- exactement cette règle — EUR vient de l'item, le reste de cette table.
--
-- `amount` est dans les UNITÉS MINEURES de la devise : des cents pour USD ou
-- GBP, mais des yens entiers pour JPY, qui n'a pas de subdivision. Ne jamais
-- supposer deux décimales.
--
-- Une devise absente ici n'est PAS facturée en euros par défaut : l'achat est
-- refusé (voir shopController.initPurchase). Facturer 1,99 € à un joueur à qui
-- on a affiché un prix en dollars serait pire qu'un refus clair.
CREATE TABLE IF NOT EXISTS cosmetic_item_prices (
  item_id INT NOT NULL,
  currency CHAR(3) NOT NULL,
  amount INT NOT NULL,
  PRIMARY KEY (item_id, currency),
  FOREIGN KEY (item_id) REFERENCES cosmetic_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS purchase_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  item_id INT NOT NULL,
  order_id BIGINT NOT NULL UNIQUE,
  steam_txn_id VARCHAR(64),
  -- 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- Montant et devise RÉELLEMENT demandés à Steam, figés à l'ouverture de la
  -- transaction : un changement de prix ultérieur ne doit pas réécrire
  -- l'historique de ce qui a été facturé.
  amount INT,
  currency CHAR(3),
  -- Dernière interrogation de QueryTxn pour cette commande (voir
  -- helper/shopReconciler.ts) : sert à étaler la surveillance des
  -- remboursements au lieu de re-questionner tout l'historique à chaque tour.
  last_checked_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES cosmetic_items(id) ON DELETE CASCADE,
  -- Le réconciliateur balaie par (statut, ancienneté) à chaque tour.
  INDEX idx_purchase_ledger_status_checked (status, last_checked_at)
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

CREATE TABLE IF NOT EXISTS friendships (
  id INT AUTO_INCREMENT PRIMARY KEY,
  requester_id INT NOT NULL,
  addressee_id INT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  responded_at TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_friend_pair (requester_id, addressee_id),
  INDEX idx_friendships_addressee_status (addressee_id, status),
  INDEX idx_friendships_requester_status (requester_id, status)
);

CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  recipient_id INT NOT NULL,
  body VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_messages_conversation (sender_id, recipient_id, created_at),
  INDEX idx_messages_recipient_unread (recipient_id, read_at)
);

CREATE TABLE IF NOT EXISTS game_invites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  recipient_id INT NOT NULL,
  steam_lobby_id BIGINT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  responded_at TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_game_invites_recipient_status (recipient_id, status),
  INDEX idx_game_invites_sender_status (sender_id, status)
);

-- Stock de packs par race (voir docs/backend-contracts/race-packs.md côté
-- card-game). Ne porte QUE les races réelles : le stock multirace reste
-- users.free_packs, inchangé, pour qu'aucun pack déjà possédé n'ait à être
-- migré. Le `free_packs` renvoyé au client est la somme des deux (voir
-- currencyModel.getFreePacks).
CREATE TABLE IF NOT EXISTS user_pack_stock (
  user_id INT NOT NULL,
  race VARCHAR(20) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, race),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- État d'exploitation, écrit depuis l'EXTÉRIEUR de l'application : le script
-- scripts/backup-db.sh y pose `last_backup_at` à chaque sauvegarde réussie, et
-- la route /api/health le relit. Le script tourne sur l'hôte, l'API dans un
-- conteneur, et aucun volume n'est partagé : la base est le seul endroit que
-- les deux atteignent déjà, sans ajouter de montage.
-- `key` est un mot réservé MySQL, d'où les backticks partout où il apparaît.
CREATE TABLE IF NOT EXISTS system_status (
  `key` VARCHAR(64) NOT NULL,
  value VARCHAR(255) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
);

INSERT IGNORE INTO wishlist_stats (id, count) VALUES (1, 0);

-- Catalogue vendable de la boutique. `steam_item_id` est la clé de liaison
-- avec le jeu (voir CARD_BACKS dans scripts/settings/CardBackShop.gd côté
-- client) ET l'itemid déclaré à Steam : le renommer casse les deux, au même
-- titre qu'un nom de carte (voir « Lien carte client↔backend »).
-- price_cents est le montant réellement encaissé par Steam, en centimes
-- d'euro : c'est CETTE valeur qui fait foi, celle du client n'est qu'un repli
-- d'affichage le temps que ce catalogue arrive.
-- INSERT IGNORE : rejouable à chaque démarrage sans écraser un prix modifié
-- en base (changer un prix se fait par un UPDATE explicite, pas ici).
INSERT IGNORE INTO cosmetic_items (steam_item_id, name, category, price_cents) VALUES
  ('card_back_gold',    'Dos doré',      'card_back', 199),
  ('card_back_crimson', 'Dos pourpre',   'card_back', 299),
  ('card_back_emerald', 'Dos émeraude',  'card_back', 399),
  ('card_back_violet',  'Dos améthyste', 'card_back', 499);

-- Prix hors zone euro. L'euro n'est PAS répété ici, il vient de
-- cosmetic_items.price_cents (voir le commentaire de la table).
--
-- Jointure sur steam_item_id et non sur un id codé en dur : `id` est
-- auto-incrémenté, sa valeur dépend de l'ordre d'insertion et diffère donc
-- d'une base à l'autre. steam_item_id, lui, est l'identifiant stable.
--
-- ⚠ JPY est en unités ENTIÈRES (240 = 240 ¥, pas 2,40 ¥) : le yen n'a pas de
-- subdivision. Ajouter une devise sans décimales demande donc de penser le
-- montant dans son unité mineure réelle, pas de recopier un prix en centimes.
--
-- Une devise absente fait refuser l'achat avec un message clair (409), elle ne
-- retombe jamais sur l'euro. Ajouter un marché = ajouter quatre lignes ici,
-- plus la grille correspondante côté dashboard Steamworks.
INSERT IGNORE INTO cosmetic_item_prices (item_id, currency, amount)
SELECT ci.id, p.currency, p.amount
FROM cosmetic_items ci
JOIN (
  SELECT 'card_back_gold' AS steam_item_id, 'USD' AS currency, 199 AS amount
  UNION ALL SELECT 'card_back_crimson', 'USD', 299
  UNION ALL SELECT 'card_back_emerald', 'USD', 399
  UNION ALL SELECT 'card_back_violet',  'USD', 499
  UNION ALL SELECT 'card_back_gold',    'GBP', 169
  UNION ALL SELECT 'card_back_crimson', 'GBP', 249
  UNION ALL SELECT 'card_back_emerald', 'GBP', 329
  UNION ALL SELECT 'card_back_violet',  'GBP', 419
  UNION ALL SELECT 'card_back_gold',    'CAD', 269
  UNION ALL SELECT 'card_back_crimson', 'CAD', 399
  UNION ALL SELECT 'card_back_emerald', 'CAD', 529
  UNION ALL SELECT 'card_back_violet',  'CAD', 659
  UNION ALL SELECT 'card_back_gold',    'AUD', 299
  UNION ALL SELECT 'card_back_crimson', 'AUD', 449
  UNION ALL SELECT 'card_back_emerald', 'AUD', 599
  UNION ALL SELECT 'card_back_violet',  'AUD', 749
  UNION ALL SELECT 'card_back_gold',    'JPY', 240
  UNION ALL SELECT 'card_back_crimson', 'JPY', 360
  UNION ALL SELECT 'card_back_emerald', 'JPY', 480
  UNION ALL SELECT 'card_back_violet',  'JPY', 600
) AS p ON p.steam_item_id = ci.steam_item_id;
