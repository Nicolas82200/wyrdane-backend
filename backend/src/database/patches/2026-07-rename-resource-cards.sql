-- Patch non destructif pour une base déjà en place (db:migrate DROP toute la
-- base, ne pas l'utiliser pour ça). Aligne les noms des cartes-ressource
-- Mort-Vivant et Démon sur le client Godot (renommées « Chair » et « Âme »
-- lors de la passe de traduction côté jeu) : le client fait le lien
-- catalogue ↔ carte par le nom exact, un nom divergent rend la carte
-- invisible dans la collection (grisée dans le deck builder).
-- Usage : mysql --default-character-set=utf8mb4 ... wyrdane_game < ce_fichier

UPDATE cards
SET name = 'Chair',
    effect = 'Ajoute 1 Chair à votre réserve. Vous ne pouvez jouer qu''une ressource par tour.'
WHERE name = 'Éclat d''Âme' AND card_type = 'Ressource';

UPDATE cards
SET name = 'Âme',
    effect = 'Ajoute 1 Âme à votre réserve. Vous ne pouvez jouer qu''une ressource par tour.'
WHERE name = 'Fragment de Pacte' AND card_type = 'Ressource';
