import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Garde-fou RGPD (article 17) : `accountModel.deleteUserData` énumère ses
// tables À LA MAIN. Rien ne reliait cette liste au schéma, donc toute table
// ajoutée ensuite était oubliée en silence — c'est arrivé deux fois
// (`onboarding_quests`, `user_pack_stock`, ajoutées après la suppression de
// compte et absentes de sa liste jusqu'au 2026-11-15).
//
// Ce test lit le schéma plutôt qu'une liste de noms recopiée : toute table
// portant une clé étrangère vers `users` doit être soit effacée par
// `deleteUserData`, soit inscrite ci-dessous comme conservée volontairement.
// Une nouvelle table fait donc échouer ce test jusqu'à ce que quelqu'un
// TRANCHE — l'effacer ou justifier sa conservation — au lieu de la laisser
// passer par défaut.
//
// Analyse statique (lecture de texte), sans base ni mock : ce qu'on veut
// vérifier est précisément que le CODE cite la table, pas qu'un appel mocké
// a eu lieu.

const SCHEMA = readFileSync(join(__dirname, "..", "database", "schema.sql"), "utf8");
const ACCOUNT_MODEL = readFileSync(join(__dirname, "accountModel.ts"), "utf8");

// Conservées sciemment, chacune pour une raison qui survit à l'effacement du
// compte (voir l'en-tête de accountModel.ts) : l'anonymisation du compte
// `users` suffit à ce qu'elles ne soient plus rattachables à une personne.
//   - match_history : l'adversaire garde son propre historique intact ;
//   - purchase_ledger / currency_ledger : traçabilité des achats réels, qu'une
//     obligation comptable impose de garder indépendamment du compte.
// N'ajouter une entrée ici qu'avec sa raison, jamais pour faire taire le test.
const KEPT_ON_PURPOSE = new Set(["match_history", "purchase_ledger", "currency_ledger"]);

// Tolère les deux fins de bloc du schéma (`);` nu ou `) ENGINE=...;`).
const CREATE_TABLE_RE = /CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\s*\(([\s\S]*?)\n\)[^;]*;/g;

const tablesLinkedToUsers = (): string[] => {
	const tables: string[] = [];
	for (const [, table, body] of SCHEMA.matchAll(CREATE_TABLE_RE)) {
		// `users` elle-même n'est pas supprimée mais anonymisée (UPDATE), elle
		// n'entre donc pas dans ce décompte.
		if (table === "users") continue;
		if (/REFERENCES\s+`?users`?\s*\(/i.test(body)) tables.push(table);
	}
	return tables;
};

describe("couverture de la suppression de compte", () => {
	// Sans cette assertion, une regex cassée par un changement de format du
	// schéma rendrait les tests suivants verts sur une liste VIDE : le garde-fou
	// disparaîtrait sans que rien ne le signale.
	it("trouve bien les tables rattachées à un joueur dans le schéma", () => {
		const tables = tablesLinkedToUsers();
		expect(tables.length).toBeGreaterThan(15);
		expect(tables).toContain("linked_accounts");
		expect(tables).toContain("messages");
	});

	it("efface ou conserve explicitement chaque table rattachée à un joueur", () => {
		const uncovered = tablesLinkedToUsers().filter((table) => {
			if (KEPT_ON_PURPOSE.has(table)) return false;
			return !new RegExp(`DELETE FROM ${table}\\b`).test(ACCOUNT_MODEL);
		});

		// Si ce test échoue, le tableau affiché EST la liste des tables à traiter :
		// ajouter un `DELETE FROM <table> WHERE user_id = ?` dans deleteUserData,
		// ou l'inscrire dans KEPT_ON_PURPOSE avec sa justification.
		expect(uncovered).toEqual([]);
	});

	it("ne conserve pas dans sa liste une table disparue du schéma", () => {
		const existing = new Set(tablesLinkedToUsers());
		const stale = [...KEPT_ON_PURPOSE].filter((table) => !existing.has(table));
		expect(stale).toEqual([]);
	});
});
