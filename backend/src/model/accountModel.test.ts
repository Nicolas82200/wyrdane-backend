import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

import db from "./db";
import { deleteUserData, ANONYMIZED_USERNAME } from "./accountModel";

// Couvre la suppression de compte (RGPD) — le code le plus destructeur de la
// base. On vérifie ce qui est irréversible : que le SteamID part, que le contenu
// personnel part, que ce qui doit survivre survit, et qu'une panne en cours de
// route ne laisse pas un compte à moitié effacé.

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };

interface FakeConnection {
	query: ReturnType<typeof vi.fn>;
	beginTransaction: ReturnType<typeof vi.fn>;
	commit: ReturnType<typeof vi.fn>;
	rollback: ReturnType<typeof vi.fn>;
	release: ReturnType<typeof vi.fn>;
}

const fakeConnection = (): FakeConnection => ({
	query: vi.fn().mockResolvedValue([[]]),
	beginTransaction: vi.fn().mockResolvedValue(undefined),
	commit: vi.fn().mockResolvedValue(undefined),
	rollback: vi.fn().mockResolvedValue(undefined),
	release: vi.fn(),
});

// Toutes les requêtes émises, concaténées : permet d'affirmer qu'une table est
// touchée (ou ne l'est pas) sans dépendre de l'ordre exact des instructions.
const sqlOf = (connection: FakeConnection): string =>
	connection.query.mock.calls.map((call) => String(call[0])).join(" | ");

describe("deleteUserData", () => {
	let connection: FakeConnection;

	beforeEach(() => {
		vi.resetAllMocks();
		connection = fakeConnection();
		mockedDb.getConnection.mockResolvedValue(connection);
	});

	it("retire le SteamID, seule donnée qui rattache le compte à une personne", async () => {
		await deleteUserData(42);
		expect(sqlOf(connection)).toContain("DELETE FROM linked_accounts");
	});

	it("purge le contenu personnel et social", async () => {
		await deleteUserData(42);
		const sql = sqlOf(connection);
		for (const table of [
			"messages",
			"friendships",
			"game_invites",
			"referrals",
			"login_events",
			"decks",
			"user_cards",
			"ranked_stats",
		]) {
			expect(sql).toContain(`DELETE FROM ${table}`);
		}
	});

	// Le point qui justifie toute l'approche par anonymisation : un DELETE sec sur
	// `users` aurait emporté l'historique de l'adversaire (cascade sur player1_id
	// ET player2_id) et les écritures comptables.
	it("ne touche ni l'historique de parties ni les journaux comptables", async () => {
		await deleteUserData(42);
		const sql = sqlOf(connection);
		expect(sql).not.toContain("DELETE FROM match_history");
		expect(sql).not.toContain("DELETE FROM purchase_ledger");
		expect(sql).not.toContain("DELETE FROM currency_ledger");
		expect(sql).not.toContain("DELETE FROM users");
	});

	it("anonymise la ligne du compte et l'horodate", async () => {
		await deleteUserData(42);
		const update = connection.query.mock.calls.find((call) => String(call[0]).includes("UPDATE users"));
		expect(update).toBeDefined();
		expect(String(update?.[0])).toContain("deleted_at = CURRENT_TIMESTAMP");
		expect(update?.[1]).toEqual([ANONYMIZED_USERNAME, 42]);
	});

	it("retire aussi le rôle admin, pour qu'un compte effacé ne garde aucun pouvoir", async () => {
		await deleteUserData(42);
		const update = connection.query.mock.calls.find((call) => String(call[0]).includes("UPDATE users"));
		expect(String(update?.[0])).toContain("is_admin = FALSE");
	});

	it("valide la transaction et rend la connexion", async () => {
		await deleteUserData(42);
		expect(connection.beginTransaction).toHaveBeenCalled();
		expect(connection.commit).toHaveBeenCalled();
		expect(connection.rollback).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalled();
	});

	// Sans rollback, une panne au milieu laisserait un compte sans SteamID mais
	// avec ses messages : ni utilisable, ni effacé.
	it("annule tout et rend la connexion si une requête échoue", async () => {
		connection.query.mockRejectedValueOnce(new Error("deadlock"));
		await expect(deleteUserData(42)).rejects.toThrow("deadlock");
		expect(connection.rollback).toHaveBeenCalled();
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalled();
	});

	it("n'agit que sur l'identifiant demandé", async () => {
		await deleteUserData(7);
		for (const call of connection.query.mock.calls) {
			const params = (call[1] ?? []) as unknown[];
			for (const param of params) {
				if (typeof param === "number") expect(param).toBe(7);
			}
		}
	});
});
