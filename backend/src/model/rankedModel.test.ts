import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

import db from "./db";
import { confirmMatch } from "./rankedModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };

interface StatsRow {
	user_id: number;
	mmr: number;
	win_streak: number;
}

// connection.query générique : la SELECT ... FOR UPDATE renvoie les lignes
// fournies (mmr/win_streak de départ des deux joueurs), tout le reste
// (INSERT ranked_stats, UPDATE, INSERT match_history, credit()...) répond un
// succès générique — seuls les appels UPDATE/INSERT currency_ledger sont
// inspectés individuellement dans les tests via connection.query.mock.calls.
const makeConnection = (statsRows: StatsRow[]) => {
	const connection = {
		query: vi.fn(),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	};
	connection.query.mockImplementation((sql: unknown) => {
		if (typeof sql === "string" && sql.includes("FOR UPDATE")) {
			return Promise.resolve([statsRows]);
		}
		return Promise.resolve([{}]);
	});
	return connection;
};

// Trouve l'appel UPDATE ranked_stats dont le dernier paramètre lié (user_id)
// correspond à userId, pour vérifier le win_streak (4e paramètre) et les
// wins/losses appliqués à CE joueur précisément (les deux joueurs partagent
// le même texte de requête).
const findRankedStatsUpdate = (connection: { query: ReturnType<typeof vi.fn> }, userId: number) =>
	connection.query.mock.calls.find(
		([sql, params]) =>
			typeof sql === "string" &&
			sql.startsWith("UPDATE ranked_stats") &&
			Array.isArray(params) &&
			params[4] === userId,
	)?.[1] as unknown[] | undefined;

const findLedgerInsert = (connection: { query: ReturnType<typeof vi.fn> }, userId: number) =>
	connection.query.mock.calls.find(
		([sql, params]) =>
			typeof sql === "string" &&
			sql.includes("INSERT INTO currency_ledger") &&
			Array.isArray(params) &&
			params[0] === userId,
	)?.[1] as unknown[] | undefined;

describe("confirmMatch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("credits the base win reward (10) for a fresh win streak, and a flat 5 to the loser", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 0 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		const { reward } = await confirmMatch("m1", 1, 2, 1);

		expect(reward).toBe(10);
		expect(findLedgerInsert(connection, 1)).toEqual([1, 10, "match_win_ranked", "m1"]);
		expect(findLedgerInsert(connection, 2)).toEqual([2, 5, "match_loss_ranked", "m1"]);
		expect(findRankedStatsUpdate(connection, 1)?.[3]).toBe(1); // new win_streak
		expect(findRankedStatsUpdate(connection, 2)?.[3]).toBe(0);
		expect(connection.commit).toHaveBeenCalledTimes(1);
	});

	it("scales the winner's reward to 15 gold once their streak reaches 3", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 2 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		const { reward } = await confirmMatch("m2", 1, 2, 1);

		expect(reward).toBe(15);
		expect(findLedgerInsert(connection, 1)).toEqual([1, 15, "match_win_ranked", "m2"]);
	});

	it("scales the winner's reward to 20 gold at streak 5 and 25 at streak 7+", async () => {
		const connectionAtFive = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 4 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connectionAtFive);
		expect((await confirmMatch("m3", 1, 2, 1)).reward).toBe(20);

		const connectionAtNine = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 8 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connectionAtNine);
		expect((await confirmMatch("m4", 1, 2, 1)).reward).toBe(25);
	});

	it("returns the caller's own reward (not the winner's) when player1 is the loser", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 4 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		const { reward } = await confirmMatch("m5", 1, 2, 2);

		expect(reward).toBe(5);
		expect(findLedgerInsert(connection, 2)).toEqual([2, 10, "match_win_ranked", "m5"]);
	});

	it("resets the loser's win streak to 0 even if they had one going into the match", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 6 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await confirmMatch("m6", 1, 2, 2);

		expect(findRankedStatsUpdate(connection, 1)?.[3]).toBe(0);
	});

	it("rolls back and rethrows if a query fails mid-transaction", async () => {
		const connection = {
			query: vi.fn().mockRejectedValue(new Error("db exploded")),
			beginTransaction: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			release: vi.fn(),
		};
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(confirmMatch("m7", 1, 2, 1)).rejects.toThrow("db exploded");

		expect(connection.rollback).toHaveBeenCalledTimes(1);
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledTimes(1);
	});
});
