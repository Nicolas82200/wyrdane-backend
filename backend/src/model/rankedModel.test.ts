import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

// levelModel a ses propres tests dédiés (levelModel.test.ts) : ici on ne
// vérifie que le câblage (confirmMatch appelle winXpForStreak avec la série
// déjà incrémentée du vainqueur puis applyXp avec le montant renvoyé, et
// renvoie l'état renvoyé par applyXp pour player1Id), pas la logique de
// multiplicateur par série elle-même — le mock ci-dessous ne réplique le
// palier (streak >= 3) que pour distinguer les deux cas dans les tests.
vi.mock("./levelModel", () => ({
	applyXp: vi.fn(),
	XP_LOSS_NETWORK: 15,
	winXpForStreak: vi.fn((streak: number) => (streak >= 3 ? 75 : 50)),
}));

import db from "./db";
import { applyXp, winXpForStreak } from "./levelModel";
import { confirmMatch, getMatchHistory } from "./rankedModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedApplyXp = applyXp as ReturnType<typeof vi.fn>;
const mockedWinXpForStreak = winXpForStreak as ReturnType<typeof vi.fn>;

interface StatsRow {
	user_id: number;
	mmr: number;
	win_streak: number;
}

// connection.query générique : la SELECT ... FOR UPDATE sur ranked_stats
// renvoie les lignes fournies (mmr/win_streak de départ des deux joueurs),
// tout le reste (INSERT ranked_stats, UPDATE, INSERT match_history...)
// répond un succès générique.
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

const findMatchHistoryInsert = (connection: { query: ReturnType<typeof vi.fn> }) =>
	connection.query.mock.calls.find(
		([sql]) => typeof sql === "string" && sql.includes("INSERT INTO match_history"),
	)?.[1] as unknown[] | undefined;

const defaultLevelResult = (level: number) => ({ level, xp: 0, xpToNext: 100, rewards: [] });

describe("confirmMatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApplyXp.mockImplementation((userId: number) => Promise.resolve(defaultLevelResult(1)));
	});

	it("awards XP_WIN_NETWORK to the winner and XP_LOSS_NETWORK to the loser", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 0 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		const { xpGained } = await confirmMatch("m1", 1, 2, 1);

		expect(xpGained).toBe(50);
		expect(mockedApplyXp).toHaveBeenCalledWith(1, 50, connection);
		expect(mockedApplyXp).toHaveBeenCalledWith(2, 15, connection);
	});

	it("returns the caller's own XP result (not the opponent's) when player1 is the loser", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 0 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		const { xpGained } = await confirmMatch("m2", 1, 2, 2);

		expect(xpGained).toBe(15);
		expect(mockedApplyXp).toHaveBeenCalledWith(1, 15, connection);
		expect(mockedApplyXp).toHaveBeenCalledWith(2, 50, connection);
	});

	it("journals the raw XP awarded, the MMR change of each player and the duration on match_history", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 0 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await confirmMatch("m3", 1, 2, 1, "ranked", 245);

		const params = findMatchHistoryInsert(connection);
		// Elo à MMR égal (1000/1000), K=32 : gagnant +16, perdant -16.
		expect(params).toEqual(["m3", 1, 2, 1, 1, 50, 15, 16, -16, 245]);
	});

	it("defaults duration_sec to 0 when the caller does not pass one", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 0 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await confirmMatch("m3b", 1, 2, 1);

		const params = findMatchHistoryInsert(connection);
		expect(params?.[9]).toBe(0);
	});

	it("never journals the hidden MMR delta of a Normal match on match_history (hidden_mmr must never leak to the client)", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, hidden_mmr: 1200, win_streak: 0 },
			{ user_id: 2, mmr: 1000, hidden_mmr: 1200, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await confirmMatch("m3c", 1, 2, 1, "normal", 100);

		const params = findMatchHistoryInsert(connection);
		// mmr_change_player1/2 (index 7/8) restent à 0 même si hidden_mmr a bougé
		// en interne (voir l'UPDATE ranked_stats SET hidden_mmr = ... plus bas).
		expect(params?.[7]).toBe(0);
		expect(params?.[8]).toBe(0);
	});

	it("surfaces the level/xp/rewards returned by applyXp for player1Id", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 0 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedApplyXp.mockImplementation((userId: number) =>
			Promise.resolve(
				userId === 1
					? { level: 5, xp: 3, xpToNext: 140, rewards: [{ level: 5, type: "card" }] }
					: defaultLevelResult(1),
			),
		);

		const result = await confirmMatch("m4", 1, 2, 1);

		expect(result.level).toBe(5);
		expect(result.xp).toBe(3);
		expect(result.xpToNext).toBe(140);
		expect(result.rewards).toEqual([{ level: 5, type: "card" }]);
	});

	it("passes the winner's incremented streak to winXpForStreak, not the loser's", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 4 },
			{ user_id: 2, mmr: 1000, win_streak: 6 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		const { xpGained } = await confirmMatch("m5b", 1, 2, 1);

		expect(mockedWinXpForStreak).toHaveBeenCalledWith(5); // 4 + 1
		expect(mockedWinXpForStreak).not.toHaveBeenCalledWith(0);
		expect(xpGained).toBe(75); // streak 5 >= 3 dans le mock
		expect(mockedApplyXp).toHaveBeenCalledWith(1, 75, connection);
		expect(mockedApplyXp).toHaveBeenCalledWith(2, 15, connection);
	});

	it("resets the loser's win streak to 0 even if they had one going into the match", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 6 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await confirmMatch("m5", 1, 2, 2);

		const update = connection.query.mock.calls.find(
			([sql, params]) =>
				typeof sql === "string" &&
				sql.startsWith("UPDATE ranked_stats") &&
				Array.isArray(params) &&
				params[4] === 1,
		)?.[1] as unknown[];
		expect(update?.[3]).toBe(0);
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

		await expect(confirmMatch("m6", 1, 2, 1)).rejects.toThrow("db exploded");

		expect(connection.rollback).toHaveBeenCalledTimes(1);
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledTimes(1);
	});
});

describe("getMatchHistory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("queries with the caller's id repeated for each IF() branch plus the limit", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);

		await getMatchHistory(42, 20);

		const [sql, params] = mockedDb.query.mock.calls[0];
		expect(sql).toContain("FROM match_history");
		expect(params).toEqual([42, 42, 42, 42, 42, 20]);
	});

	it("returns the rows as-is (opponent identity/deck and per-caller MMR change already resolved in SQL)", async () => {
		const rows = [
			{
				client_match_id: "m1",
				played_at: "2026-09-20 10:00:00",
				duration_sec: 300,
				winner_id: 42,
				mmr_change: 16,
				opponent_username: "Rival",
				opponent_deck_races: ["Undead"],
			},
		];
		mockedDb.query.mockResolvedValueOnce([rows]);

		const result = await getMatchHistory(42, 20);

		expect(result).toEqual(rows);
	});
});
