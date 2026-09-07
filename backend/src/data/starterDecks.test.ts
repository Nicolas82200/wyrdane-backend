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
});
