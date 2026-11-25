-- Patch non destructif pour une base déjà peuplée (db:migrate DROP toute la
-- base, ne pas l'utiliser pour ça). Renomme EN PLACE les 42 cartes Abomination
-- de collection renommées côté jeu le 2026-11-25 (voir docs/abomination-naming.md
-- dans le dépôt card-game) : le client fait le lien catalogue ↔ carte par le nom
-- FR exact, un nom divergent écarte la carte en silence de la collection, des
-- decks et de la révélation de pack (un pack de 5 cartes en affichait 4).
--
-- ⚠ À jouer AVANT toute sync de cards_data.sql : syncCardsFromFile fait
-- correspondre par nom et ne supprime jamais de ligne, donc sans ce renommage
-- préalable elle insérerait 42 lignes neuves et laisserait les anciennes
-- orphelines — les user_cards/deck_cards des joueurs pointant alors sur des ids
-- dont le nom n'existe plus côté jeu.
--
-- Les 2 cartes Abomination `arena_only` renommées le même jour (Prototype
-- Instable → Ébauche, Charognard Vorace → Mâchoire Avide) ne sont pas ici :
-- elles ne sont pas dans la table cards.
--
-- Usage : mysql --default-character-set=utf8mb4 ... wyrdane_game < ce_fichier
-- NB : également appliqué automatiquement au démarrage du serveur (pendant
-- TypeScript dans src/database/dataPatches.ts) — garder les deux en phase.

UPDATE cards SET name = 'Haleine Commune' WHERE name = 'Respir Qui Change Tout' AND race = 'Abomination';

UPDATE cards SET name = 'Rituel de la Digestion' WHERE name = 'Rituel du Ventre Qui Prend Tout' AND race = 'Abomination';

UPDATE cards SET name = 'Puits Glouton' WHERE name = 'Puits Qui Avale Tout' AND race = 'Abomination';

UPDATE cards SET name = 'Jachère' WHERE name = 'Ce Qu''on a Laissé Pousser' AND race = 'Abomination';

UPDATE cards SET name = 'Appel Entendu' WHERE name = 'Signe Qui Répond' AND race = 'Abomination';

UPDATE cards SET name = 'Visage Encore Flou' WHERE name = 'Visage-Encore-Flou' AND race = 'Abomination';

UPDATE cards SET name = 'Gosier Béant' WHERE name = 'Faim Sans Fond' AND race = 'Abomination';

UPDATE cards SET name = 'Masse Mouvante' WHERE name = 'Masse-Qui-Ne-Cesse' AND race = 'Abomination';

UPDATE cards SET name = 'Aura de Croissance' WHERE name = 'Halo Qui Encourage le Changement' AND race = 'Abomination';

UPDATE cards SET name = 'Vapeur Tenace' WHERE name = 'Vapeur Qui S''Accroche' AND race = 'Abomination';

UPDATE cards SET name = 'La Main Qui Choisit' WHERE name = 'Main-Qui-Choisit' AND race = 'Abomination';

UPDATE cards SET name = 'Débordement' WHERE name = 'Ce-Qui-N''a-Plus-de-Bords' AND race = 'Abomination';

UPDATE cards SET name = 'L''Interminable' WHERE name = 'Ce-Qui-Ne-Finit-Jamais-de-Grandir' AND race = 'Abomination';

UPDATE cards SET name = 'Tressaut' WHERE name = 'Premier Tressaut' AND race = 'Abomination';

UPDATE cards SET name = 'Mémoire de Chair' WHERE name = 'Ce-Qui-Se-Souvient-Par-le-Corps' AND race = 'Abomination';

UPDATE cards SET name = 'Fureur Informe' WHERE name = 'Fureur Sans Forme Fixe' AND race = 'Abomination';

UPDATE cards SET name = 'Diminution' WHERE name = 'Étau de Chair Neuve' AND race = 'Abomination';

UPDATE cards SET name = 'Peau Trop Grande' WHERE name = 'Peau-Trop-Grande' AND race = 'Abomination';

UPDATE cards SET name = 'Emprunt Bref' WHERE name = 'Emprunt Instantané' AND race = 'Abomination';

UPDATE cards SET name = 'Antre Affamé' WHERE name = 'Repaire Qui Digère la Magie' AND race = 'Abomination';

UPDATE cards SET name = 'Cavalier Fondu' WHERE name = 'Monture-et-Cavalier-Ne-Font-Qu''Un' AND race = 'Abomination';

UPDATE cards SET name = 'Pluie Mauvaise' WHERE name = 'Pluie Qui Change' AND race = 'Abomination';

UPDATE cards SET name = 'Doigt Dans les Nerfs' WHERE name = 'Doigt-Dans-les-Nerfs' AND race = 'Abomination';

UPDATE cards SET name = 'Dédoublement' WHERE name = 'Un-Devenu-Plusieurs' AND race = 'Abomination';

UPDATE cards SET name = 'Excroissance' WHERE name = 'Ce-Qui-A-Trop-Poussé' AND race = 'Abomination';

UPDATE cards SET name = 'Le Grand Retour' WHERE name = 'Grand Retour Sous une Autre Forme' AND race = 'Abomination';

UPDATE cards SET name = 'Rituel de la Chair Recousue' WHERE name = 'Rituel de la Chair Qui Recoud' AND race = 'Abomination';

UPDATE cards SET name = 'Rituel du Remodelage' WHERE name = 'Rituel de la Forme Jamais Fixée' AND race = 'Abomination';

UPDATE cards SET name = 'Sommeil Rongeur' WHERE name = 'Sommeil Qui Ronge' AND race = 'Abomination';

UPDATE cards SET name = 'Essaimage' WHERE name = 'Ce-Qui-Se-Partage' AND race = 'Abomination';

UPDATE cards SET name = 'Murmure Précoce' WHERE name = 'Chuchotement Qui Change la Forme' AND race = 'Abomination';

UPDATE cards SET name = 'Poussière Mordante' WHERE name = 'Poussière Qui Change' AND race = 'Abomination';

UPDATE cards SET name = 'Clameur de Chair' WHERE name = 'Chant Qui Déforme' AND race = 'Abomination';

UPDATE cards SET name = 'Curée' WHERE name = 'Appétit Ciblé' AND race = 'Abomination';

UPDATE cards SET name = 'La Repousse' WHERE name = 'L''Éternel Recommencement' AND race = 'Abomination';

UPDATE cards SET name = 'Rituel du Fil Tendu' WHERE name = 'Rituel du Fil Sous la Peau' AND race = 'Abomination';

UPDATE cards SET name = 'L''Occupant' WHERE name = 'Locataire Sans Bail' AND race = 'Abomination';

UPDATE cards SET name = 'Autel Aveugle' WHERE name = 'Autel Qui Ne Reconnaît Rien' AND race = 'Abomination';

UPDATE cards SET name = 'Prolifération' WHERE name = 'Ce-Qui-A-Cessé-de-S''arrêter' AND race = 'Abomination';

UPDATE cards SET name = 'Voix Sous la Peau' WHERE name = 'Voix-Sous-la-Peau' AND race = 'Abomination';

UPDATE cards SET name = 'Le Fardeau' WHERE name = 'Le Poids-Qui-Marche' AND race = 'Abomination';

UPDATE cards SET name = 'Le Dernier Reste' WHERE name = 'Le Reste-Qui-Veille' AND race = 'Abomination';
