import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));
vi.mock("./currencyModel", () => ({
	creditFreePacks: vi.fn(),
	getFreePacks: vi.fn(),
}));

import db from "./db";
import { creditFreePacks, getFreePacks } from "./currencyModel";
import {
	WEEKLY_QUEST_TEMPLATES,
	WeeklyQuestNotFoundError,
	WeeklyQuestNotCompletedError,
	WeeklyQuestAlreadyClaimedError,
	ensureThisWeekQuests,
	getWeeklyQuests,
	progressForMatch,
	claimWeeklyQuest,
} from "./weeklyQuestModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;
const mockedGetFreePacks = getFreePacks as ReturnType<typeof vi.fn>;

const templateRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 1,
	user_id: 1,
	week_start: "2026-08-24",
	slot: 0,
	quest_code: WEEKLY_QUEST_TEMPLATES[0].code,
	progress: 0,
	target: WEEKLY_QUEST_TEMPLATES[0].target,
	reward_pack: WEEKLY_QUEST_TEMPLATES[0].rewardPack,
	claimed_at: null,
	...overrides,
});

describe("ensureThisWeekQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts 1 quest then returns it for the week", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[templateRow({ slot: 0 })]]);

		const rows = await ensureThisWeekQuests(1);

		// 1 upsert (ON DUPLICATE KEY UPDATE) + 1 SELECT
		expect(mockedDb.query).toHaveBeenCalledTimes(2);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, 0, expect.any(String), expect.any(Number), expect.any(Number)],
		);
		expect(rows).toHaveLength(1);
	});
});

describe("getWeeklyQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to the client-facing shape, including claimed status", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([
			[templateRow({ progress: 1, claimed_at: null }), templateRow({ id: 2, claimed_at: "2026-08-24T10:00:00Z" })],
		]);

		const result = await getWeeklyQuests(1);

		expect(result.quests).toEqual([
			expect.objectContaining({ id: 1, progress: 1, claimed: false }),
			expect.objectContaining({ id: 2, claimed: true }),
		]);
		expect(result.resets_at).toBeTruthy();
	});
});

describe("progressForMatch", () => {
	beforeEach(() => vi.clearAllMocks());

	const queueEnsureThisWeekQuests = (rows: unknown[]) => {
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([rows]);
	};

	it("increments a 'play' quest regardless of mode or outcome", async () => {
		const playTemplate = WEEKLY_QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureThisWeekQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: playTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("increments a 'win_network' quest on a network win", async () => {
		const networkTemplate = WEEKLY_QUEST_TEMPLATES.find((t) => t.objective === "win_network")!;
		queueEnsureThisWeekQuests([templateRow({ quest_code: networkTemplate.code, progress: 0, target: networkTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "ranked", true);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("does not increment a 'win_network' quest on a solo win", async () => {
		const networkTemplate = WEEKLY_QUEST_TEMPLATES.find((t) => t.objective === "win_network")!;
		queueEnsureThisWeekQuests([templateRow({ quest_code: networkTemplate.code, progress: 0, target: networkTemplate.target })]);

		await progressForMatch(1, "solo", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("does not increment a 'win_network' quest on a network loss", async () => {
		const networkTemplate = WEEKLY_QUEST_TEMPLATES.find((t) => t.objective === "win_network")!;
		queueEnsureThisWeekQuests([templateRow({ quest_code: networkTemplate.code, progress: 0, target: networkTemplate.target })]);

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("increments a 'play_race' quest by the number of cards played of that race", async () => {
		const raceTemplate = WEEKLY_QUEST_TEMPLATES.find((t) => t.objective === "play_race" && t.race === "Demon")!;
		queueEnsureThisWeekQuests([templateRow({ quest_code: raceTemplate.code, progress: 0, target: raceTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "solo", false, { cardsPlayedByRace: { Demon: 5, Human: 2 } });

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[5, 1],
		);
	});

	it("skips quests already at their target or already claimed", async () => {
		const playTemplate = WEEKLY_QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureThisWeekQuests([
			templateRow({ id: 1, quest_code: playTemplate.code, progress: playTemplate.target, target: playTemplate.target }),
			templateRow({ id: 2, quest_code: playTemplate.code, progress: 0, target: playTemplate.target, claimed_at: "2026-08-24T00:00:00Z" }),
		]);

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("claimWeeklyQuest", () => {
	beforeEach(() => vi.clearAllMocks());

	const makeConnection = (selectResult: unknown[]) => ({
		query: vi.fn().mockResolvedValueOnce([selectResult]).mockResolvedValue([{}]),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	});

	it("throws WeeklyQuestNotFoundError when the quest doesn't belong to this user", async () => {
		const connection = makeConnection([]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimWeeklyQuest(1, 999)).rejects.toThrow(WeeklyQuestNotFoundError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
	});

	it("throws WeeklyQuestAlreadyClaimedError on a second claim", async () => {
		const connection = makeConnection([templateRow({ claimed_at: "2026-08-24T00:00:00Z" })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimWeeklyQuest(1, 1)).rejects.toThrow(WeeklyQuestAlreadyClaimedError);
	});

	it("throws WeeklyQuestNotCompletedError when progress hasn't reached target", async () => {
		const connection = makeConnection([templateRow({ progress: 0, target: 30 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimWeeklyQuest(1, 1)).rejects.toThrow(WeeklyQuestNotCompletedError);
	});

	it("marks the quest claimed and credits free_packs in a committed transaction", async () => {
		const connection = makeConnection([templateRow({ progress: 30, target: 30, reward_pack: 1 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetFreePacks.mockResolvedValueOnce(4);

		const result = await claimWeeklyQuest(1, 1);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [1]);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, 1, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ free_packs: 4, reward_pack: 1 });
	});
});
