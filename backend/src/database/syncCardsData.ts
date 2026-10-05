// Contrepartie non destructive de migrate.ts pour la table `cards` : au lieu
// de DROP + réimporter cards_data.sql (destructeur, dev/CI uniquement — voir
// migrate.ts), ce script met à jour les lignes existantes en place (UPDATE
// par `name`, la clé de correspondance jeu↔backend, voir CLAUDE.md
// "Lien carte client↔backend = nom FR exact") et insère les cartes nouvelles.
// Sûr à rejouer contre une base déjà en service, y compris la prod.
//
// Ne supprime JAMAIS de ligne : `cards.id` est référencé par `user_cards`/
// `deck_cards` en ON DELETE CASCADE, donc une suppression effacerait la
// collection/les decks des joueurs qui possèdent cette carte. Un renommage
// commande une correspondance ambiguë) sont uniquement listées à la fin
// pour revue manuelle.
//
// Usage : npm run db:sync-cards (relit cards_data.sql, généré par
// generate-cards-data.mjs — régénérer ce fichier d'abord si le jeu a changé).
// Même logique exposée en HTTP pour les environnements sans accès SSH direct
// (prod) via POST /api/admin/sync-cards, voir ../model/cardSyncModel.ts.
import "dotenv/config";
import { join } from "path";

import pool from "../model/db";
import { syncCardsFromFile } from "../model/cardSyncModel";

const CARDS_DATA_PATH = join(__dirname, "cards_data.sql");

const main = async (): Promise<void> => {
	const result = await syncCardsFromFile(CARDS_DATA_PATH);
	console.log(`→ ${result.totalRead} cartes lues depuis cards_data.sql`);
	console.log(`✓ ${result.updated} cartes mises à jour, ${result.created} nouvelles cartes créées`);
	if (result.orphaned.length > 0) {
		console.log(
			`⚠ ${result.orphaned.length} carte(s) en base absente(s) du jeu actuel (non supprimées, à vérifier manuellement — renommage ou retrait réel ?) :`,
		);
		for (const name of result.orphaned) console.log(`  - ${name}`);
	}
	await pool.end();
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
