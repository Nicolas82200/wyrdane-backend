-- Repart de zéro sur les données joueurs, sans toucher au catalogue de
-- cartes/cosmétiques (tables `cards` et `cosmetic_items`, jamais liées à un
-- user_id). Toutes les autres tables ont une FK ON DELETE CASCADE vers
-- `users` (voir schema.sql) : vider `users` suffit à cascader la suppression
-- sur linked_accounts, user_cards, decks, deck_cards, ranked_stats,
-- solo_stats, match_history, match_reports, user_cosmetics, purchase_ledger
-- et currency_ledger.
--
-- À exécuter manuellement contre la base de PRODUCTION (identifiants dans le
-- dashboard Render/hébergeur MySQL, jamais dans ce repo). Irréversible sans
-- backup préalable — faire un dump avant si un doute existe :
--   mysqldump -h <DB_HOST> -u <DB_USER> -p <DB_NAME> > backup_avant_reset.sql

DELETE FROM users;
ALTER TABLE users AUTO_INCREMENT = 1;
