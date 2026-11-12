import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { STARTER_DECKS } from "./starterDecks";

// Régression : les decks de départ sont réclamés en un seul appel transactionnel
// (claim-starter) qui échoue intégralement (pour les 4 races à la fois) si un
// seul nom de carte référencé ici ne correspond plus exactement à `cards.name`
// en base (ex. renommage de carte-ressource non répercuté ici). Ce test compare
// directement contre le dump SQL source de vérité pour attraper toute
// divergence avant qu'elle ne bloque silencieusement tous les nouveaux joueurs.
describe("STARTER_DECKS", () => {
	const sql = readFileSync(join(__dirname, "../database/cards_data.sql"), "utf-8");
	const dbCardNames = new Set(
		[...sql.matchAll(/VALUES \('((?:[^']|'')+)'/g)].map((match) => match[1].replace(/''/g, "'")),
	);

	it("references only card names that exist in cards_data.sql", () => {
		const allNames = STARTER_DECKS.flatMap((deck) => deck.entries.map((entry) => entry.name));
		const missing = allNames.filter((name) => !dbCardNames.has(name));
		expect(missing).toEqual([]);
	});

	// Le test ci-dessus ne compare le seed qu'à lui-même : il était vert alors
	// que `Sceau du Royaume` / `Éclat d'Anomalie` divergeaient du client, parce
	// que starterDecks.ts portait la même erreur que cards_data.sql. Or l'autre
	// moitié du contrat vit dans un dépôt séparé (`E:\card-game`,
	// `resources/cards/<race>/*.tres`, champ `card_name`) et le lien se fait par
	// nom FR exact. Ces 4 noms sont les plus exposés du catalogue : ils sont
	// dans les 4 decks de départ, exemptés de possession côté deck builder
	// (donc une divergence ne se voit nulle part dans la collection), et ils ont
	// déjà été renommés deux fois. On les fige ici, faute de pouvoir lire le
	// client depuis ce dépôt. Si l'un change côté jeu : mettre à jour cette
	// liste, cards_data.sql, starterDecks.ts ET ajouter l'entrée de renommage
	// dans database/dataPatches.ts (sans quoi la base de prod, déjà peuplée,
	// garde l'ancien nom).
	it("names the four race resource cards exactly as the Godot client does", () => {
		const resourceNames = [
			...readFileSync(join(__dirname, "../database/cards_data.sql"), "utf-8").matchAll(
				/VALUES \('((?:[^']|'')+)', '[^']*', 'Ressource'/g,
			),
		].map((match) => match[1].replace(/''/g, "'"));
		expect(resourceNames.sort()).toEqual(["Anomalie", "Chair", "Sceau", "Âme"].sort());
	});
});
