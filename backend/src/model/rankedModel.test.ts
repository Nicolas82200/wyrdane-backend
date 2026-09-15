import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

// levelModel a ses propres tests dédiés (levelModel.test.ts) : ici on ne
// vérifie que le câblage (confirmMatch appelle applyXp avec le bon montant
// pour chaque joueur, et renvoie l'état renvoyé par applyXp pour player1Id),
// pas la logique de récompense par niveau elle-même.
vi.mock("./levelModel", () => ({
	applyXp: vi.fn(),
	XP_WIN_NETWORK: 50,
	XP_LOSS_NETWORK: 15,
}));

import db from "./db";
import { applyXp } from "./levelModel";
import { confirmMatch } from "./rankedModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedApplyXp = applyXp as ReturnType<typeof vi.fn>;

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

	it("journals the raw XP awarded to each player on match_history", async () => {
		const connection = makeConnection([
			{ user_id: 1, mmr: 1000, win_streak: 0 },
			{ user_id: 2, mmr: 1000, win_streak: 0 },
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await confirmMatch("m3", 1, 2, 1);

		const params = findMatchHistoryInsert(connection);
		expect(params).toEqual(["m3", 1, 2, 1, 1, 50, 15]);
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
