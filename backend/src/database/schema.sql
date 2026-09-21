DROP DATABASE IF EXISTS wyrdane_game;
CREATE DATABASE IF NOT EXISTS wyrdane_game CHARACTER SET utf8mb4;
USE wyrdane_game;

DROP TABLE IF EXISTS deck_cards;
DROP TABLE IF EXISTS decks;
DROP TABLE IF EXISTS user_cards;
DROP TABLE IF EXISTS daily_quests;
DROP TABLE IF EXISTS weekly_quests;
DROP TABLE IF EXISTS monthly_quests;
DROP TABLE IF EXISTS unique_quests;
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS login_rewards;
DROP TABLE IF EXISTS match_reports;
DROP TABLE IF EXISTS match_history;
DROP TABLE IF EXISTS ranked_stats;
DROP TABLE IF EXISTS solo_stats;
DROP TABLE IF EXISTS purchase_ledger;
DROP TABLE IF EXISTS user_cosmetics;
DROP TABLE IF EXISTS cosmetic_items;
DROP TABLE IF EXISTS currency_ledger;
DROP TABLE IF EXISTS site_visits;
DROP TABLE IF EXISTS login_events;
DROP TABLE IF EXISTS wishlist_stats;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS linked_accounts;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- Pas de contrainte UNIQUE : c'est le pseudo Steam affiché (persona name,
  -- rafraîchi à chaque login, voir authController.loginWithSteamId), jamais
  -- utilisé comme clé de recherche (identité réelle = linked_accounts,
  -- external_id) — plusieurs joueurs peuvent légitimement partager le même
  -- pseudo Steam.
  username VARCHAR(50) NOT NULL,
  soft_currency INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Rempli par POST /api/collection/claim-starter (fin de tutoriel) : évite de
  -- regrant/recréer les decks de départ si le joueur relance la réclamation.
  starter_claimed_at TIMESTAMP NULL DEFAULT NULL,
  -- Rempli par POST /api/currency/claim-starter-bonus : bonus de départ
  -- (250, voir currencyModel.claimStarterBonus) distinct de starter_claimed_at
  -- (cartes/decks) pour les comptes créés avant l'ajout de ce bonus, qui
  -- reçoivent désormais 250 dès la création (voir userModel.createWithSteamAccount).
  starter_currency_claimed_at TIMESTAMP NULL DEFAULT NULL,
  -- Rempli par POST /api/currency/claim-first-login-bonus : quête cachée de
  -- première connexion Steam (500, voir currencyModel.claimFirstLoginReward).
  -- Appelée aussi bien depuis le site (après le callback OpenID) que depuis
  -- le client Godot (LoadingScreen), les deux consommateurs de cette même API.
  first_login_reward_claimed_at TIMESTAMP NULL DEFAULT NULL,
  -- Rôle admin pour la page d'administration du site (dashboard analytics) :
  -- volontairement absent du payload JWT (voir jwtHelper) et revérifié en base
  -- à chaque requête admin, car le JWT reste valide jusqu'à 1h après un retrait
  -- de droits.
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  -- Solde de packs gratuits à ouvrir (distinct de soft_currency) : alimenté
  -- par les quêtes hebdomadaires et le parrainage (voir weeklyQuestModel/
  -- referralModel), consommé par POST /api/packs/open-owned. Pas de ledger
  -- dédié (contrairement à currency_ledger) : une seule source de valeur, pas
  -- besoin d'audit fin pour l'instant.
  free_packs INT NOT NULL DEFAULT 0,
  -- Niveau de compte (voir levelModel.ts) : remplace l'ancien barème d'or par
  -- match classé. XP créditée par match réseau (classé/partie rapide, pas le
  -- solo), courbe xpToReachNextLevel : +20% par niveau sur le seuil arrondi
  -- du niveau précédent, 100 XP au niveau 1. Récompense à
  -- chaque niveau franchi (carte tous les 5, pack tous les 25, or sinon) —
  -- voir levelModel.rewardKindForLevel.
  level INT NOT NULL DEFAULT 1,
  xp INT NOT NULL DEFAULT 0
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

-- win_streak : victoires classées consécutives en cours pour ce joueur,
-- remise à 0 par n'importe quelle défaite (voir rankedModel.confirmMatch) —
-- pur stat d'affichage côté client depuis le retrait du barème d'or par
-- match (voir levelModel.ts), distinct de `wins` qui ne fait qu'accumuler.
CREATE TABLE ranked_stats (
  user_id INT PRIMARY KEY,
  mmr INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  win_streak INT NOT NULL DEFAULT 0,
  season INT NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  -- Sert getRank/getLeaderboard (profileModel.ts) : classement/rang par
  -- saison, sinon scan complet de la table à chaque affichage de profil.
  INDEX idx_ranked_stats_season_mmr (season, mmr)
);

-- File d'attente de matchmaking classé (appariement par MMR) : un ticket par
-- joueur actif, remplacé (pas dupliqué) à chaque nouvel appel à la file grâce
-- à UNIQUE KEY sur user_id. status : waiting -> matched -> (steam_lobby_id
-- renseigné une fois l'hôte connu) ; ou waiting -> cancelled/expired. role et
-- opponent_id ne sont renseignés qu'une fois status = matched. steam_lobby_id
-- en BIGINT (SteamID de lobby 64 bits), NULL tant que l'hôte n'a pas encore
-- appelé report-lobby — voir matchmakingModel.ts.
CREATE TABLE matchmaking_tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  mmr INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  opponent_id INT NULL,
  role VARCHAR(10) NULL,
  steam_lobby_id BIGINT NULL,
  match_id VARCHAR(36) NULL,
  match_session_token TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_ticket_id (ticket_id),
  UNIQUE KEY unique_user_ticket (user_id),
  INDEX idx_matchmaking_status (status)
);

-- Compteur de parties solo/vs IA (distinct de ranked_stats, pas de MMR ici) :
-- alimenté par POST /api/rewards/solo-match, indépendamment du plafond
-- quotidien de la récompense en monnaie (les stats comptent toujours).
-- win_streak : victoires consécutives vs IA en cours, remise à 0 par
-- n'importe quelle défaite (voir soloStatsModel.incrementResult) — sert de
-- palier au bonus d'or de rewardsController.reportSoloMatch, distinct de
-- `wins` qui ne fait qu'accumuler.
CREATE TABLE solo_stats (
  user_id INT PRIMARY KEY,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  win_streak INT NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Récompense de connexion quotidienne : streak_day compte les jours
-- consécutifs (pas plafonné à 7, la récompense associée boucle modulo 7 côté
-- code — voir loginRewardModel.REWARD_BY_DAY), last_claimed_date sert à
-- déterminer si la série continue (hier), reset (avant-hier ou plus) ou déjà
-- réclamée aujourd'hui, calculé via CURDATE() côté requête plutôt qu'en JS.
CREATE TABLE login_rewards (
  user_id INT PRIMARY KEY,
  streak_day INT NOT NULL DEFAULT 0,
  last_claimed_date DATE NULL DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Une ligne par récompense de niveau réellement octroyée (voir
-- levelModel.grantLevelReward, appelé dans applyXp dès qu'un palier est
-- franchi) : l'octroi (crédit d'or/carte/pack) reste immédiat et automatique
-- comme avant, cette table ne fait que le journaliser pour que le client
-- puisse l'afficher plus tard dans la popup de récompenses de niveau et le
-- marquer comme "vu" (claimed_at) — claimed_at ne déclenche aucun nouveau
-- crédit, c'est un simple accusé de réception côté joueur (voir
-- levelModel.claimRewards). Pas de card_id : la carte précise obtenue n'est
-- jamais affichée (même convention que GameOverScreen.show_xp_reward côté
-- client, qui n'affiche que la rareté) ; celle-ci est de toute façon
-- déterministe à partir du niveau (voir rewardKindForLevel), inutile de la
-- dupliquer ici.
CREATE TABLE level_rewards (
  user_id INT NOT NULL,
  level INT NOT NULL,
  type ENUM('card', 'pack', 'gold') NOT NULL,
  gold INT NOT NULL DEFAULT 0,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (user_id, level),
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
  -- XP brute accordée à chaque joueur pour ce match (voir levelModel,
  -- rankedModel.confirmMatch) : journalisée ici pour qu'un rapport rejoué
  -- après confirmation (retry réseau) puisse relire le montant exact sans
  -- le recalculer, client_match_id étant UNIQUE.
  xp_awarded_player1 INT NOT NULL DEFAULT 0,
  xp_awarded_player2 INT NOT NULL DEFAULT 0,
  FOREIGN KEY (player1_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (player2_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Un rapport par joueur et par match (client_match_id = identifiant généré
-- côté client, partagé par les deux joueurs d'une même partie P2P). Le match
-- n'est validé (cf match_history) que quand les deux rapports concordent.
-- cards_played_by_race/deck_races : snapshot déclaratif par le reporter de sa
-- propre partie (races des cartes jouées + races présentes dans son deck),
-- utilisé uniquement pour faire progresser ses quêtes de race une fois le
-- match confirmé (voir questModel.progressForMatch) — jamais pour l'autorité
-- MMR/victoire, qui reste basée sur winner_id à double rapport.
CREATE TABLE match_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_match_id VARCHAR(100) NOT NULL,
  reporter_id INT NOT NULL,
  opponent_id INT NOT NULL,
  winner_id INT NOT NULL,
  season INT NOT NULL,
  cards_played_by_race JSON NULL,
  deck_races JSON NULL,
  -- Liste brute des cartes posées par le reporter (doublons inclus si jouée
  -- plusieurs fois), utilisée une fois le match confirmé pour alimenter
  -- card_play_stats (équilibrage) — voir
  -- docs/backend-contracts/card-stats-and-leaderboard.md côté card-game.
  cards_played JSON NULL,
  reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (opponent_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_match_reporter (client_match_id, reporter_id)
);

-- Une ligne par (carte, match, joueur qui l'a jouée) — voir
-- rankedModel.recordCardPlays, appelé une seule fois par match confirmé
-- (même court-circuit findMatchHistory que le reste de reportMatch). Sert
-- uniquement de signal d'équilibrage (taux de jeu/winrate par carte, voir
-- rankedModel.getCardStats) — jamais consultée pour l'autorité MMR/victoire.
CREATE TABLE card_play_stats (
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

-- Assignation/progression des 3 quêtes quotidiennes d'un joueur (le contenu
-- des quêtes elles-mêmes — QUEST_TEMPLATES — vit en code, pas ici). Assignées
-- paresseusement au premier appel du jour (voir questModel.ensureTodayQuests),
-- pas par un job planifié.
CREATE TABLE daily_quests (
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

-- Assignation/progression de la quête hebdomadaire d'un joueur (1 slot),
-- même principe que daily_quests (contenu en code, WEEKLY_QUEST_TEMPLATES)
-- mais reset chaque lundi et récompense en packs (reward_pack) plutôt qu'en
-- or. week_start = lundi de la semaine courante (calculé côté SQL via
-- WEEKDAY(), jamais côté JS, pour rester cohérent quel que soit le fuseau du
-- serveur).
CREATE TABLE weekly_quests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  week_start DATE NOT NULL,
  slot TINYINT NOT NULL,
  quest_code VARCHAR(30) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  reward_pack INT NOT NULL,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_week_slot (user_id, week_start, slot)
);

-- Quêtes mensuelles : même principe que weekly_quests (rotation par slot,
-- reset périodique) mais objectifs plus longs et récompense double (or +
-- packs, comme unique_quests) pour une grosse récompense mensuelle. Le
-- dernier slot (LOGIN_STREAK_SLOT côté monthlyQuestModel) n'est jamais tiré
-- au sort : toujours la quête de connexion quotidienne, plus grosse
-- récompense du mois. last_progress_date sert de verrou anti-double-compte
-- le même jour pour cette quête (NULL/inutilisé pour les autres objectifs).
-- month_start = 1er du mois courant (calculé côté SQL, jamais côté JS).
CREATE TABLE monthly_quests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  month_start DATE NOT NULL,
  slot TINYINT NOT NULL,
  quest_code VARCHAR(30) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  reward_currency INT NOT NULL DEFAULT 0,
  reward_pack INT NOT NULL DEFAULT 0,
  last_progress_date DATE NULL DEFAULT NULL,
  claimed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_quest_month_slot (user_id, month_start, slot)
);

-- Quêtes uniques (one-shot) : contrairement à daily_quests/weekly_quests,
-- une seule ligne par joueur/quest_code, jamais reset, assignée une fois
-- pour toutes (voir uniqueQuestModel.ensureUniqueQuests) puis toujours
-- renvoyée en entier (pas de notion de slot/rotation). meta stocke un état
-- additionnel propre à certains objectifs (ex. liste des races déjà
-- gagnantes pour win_all_races) — NULL pour les autres.
CREATE TABLE unique_quests (
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

-- Parrainage à sens unique : un joueur ne peut parrainer qu'UN SEUL ami
-- (referrer_id UNIQUE, contrainte anti-abus posée en base plutôt qu'en
-- logique applicative) ; un compte ne peut être parrainé qu'une seule fois,
-- par n'importe qui (referred_id UNIQUE, NULL autorisé tant que le code n'a
-- pas été utilisé — MySQL n'applique pas UNIQUE entre plusieurs NULL).
-- redeemed_at : le filleul a entré le code. completed_at : le filleul a
-- terminé le tutoriel (voir users.starter_claimed_at). reward_granted_at :
-- le parrain a été crédité (3 packs + 500 or) — idempotence, jamais crédité
-- deux fois même si claim-starter est rappelé.
CREATE TABLE referrals (
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

-- Une ligne par requête de tracking envoyée par le site (POST
-- /api/analytics/pageview, public, pas d'auth requise). visitor_id vient d'un
-- cookie anonyme posé par ce même endpoint (voir analyticsModel.recordVisit) :
-- permet de distinguer visites totales et visiteurs uniques (approximatifs,
-- un même visiteur sans cookie -ou l'ayant effacé- recompte).
CREATE TABLE site_visits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visitor_id VARCHAR(64) NOT NULL,
  path VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_site_visits_visitor (visitor_id),
  INDEX idx_site_visits_created (created_at)
);

-- Une ligne par connexion Steam réussie (site OU jeu, voir authController
-- loginWithSteamId), pour compter les connexions par origine dans le
-- dashboard admin. Distinct de users.created_at (premier compte) : capture
-- CHAQUE connexion, pas seulement la première.
CREATE TABLE login_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  source VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_login_events_source_date (source, created_at)
);

-- Ligne unique (id=1) : compteur de wishlists Steam saisi manuellement depuis
-- la page admin. Pas d'API Steamworks publique fiable pour ce chiffre (visible
-- uniquement dans le dashboard partenaire Steamworks) : voir adminModel.
CREATE TABLE wishlist_stats (
  id INT PRIMARY KEY DEFAULT 1,
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT INTO wishlist_stats (id, count) VALUES (1, 0);