import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));
vi.mock("./currencyModel", () => ({
	credit: vi.fn(),
	getBalance: vi.fn(),
	creditFreePacks: vi.fn(),
	getFreePacks: vi.fn(),
}));

import db from "./db";
import { credit, getBalance, creditFreePacks, getFreePacks } from "./currencyModel";
import {
	MONTHLY_QUEST_TEMPLATES,
	MonthlyQuestNotFoundError,
	MonthlyQuestNotCompletedError,
	MonthlyQuestAlreadyClaimedError,
	ensureThisMonthQuests,
	getMonthlyQuests,
	progressForMatch,
	claimMonthlyQuest,
} from "./monthlyQuestModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;
const mockedGetFreePacks = getFreePacks as ReturnType<typeof vi.fn>;

const templateRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 1,
	user_id: 1,
	month_start: "2026-09-01",
	slot: 0,
	quest_code: MONTHLY_QUEST_TEMPLATES[0].code,
	progress: 0,
	target: MONTHLY_QUEST_TEMPLATES[0].target,
	reward_currency: MONTHLY_QUEST_TEMPLATES[0].rewardCurrency,
	reward_pack: MONTHLY_QUEST_TEMPLATES[0].rewardPack,
	claimed_at: null,
	...overrides,
});

describe("ensureThisMonthQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts 2 quests then returns them for the month", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[templateRow({ slot: 0 }), templateRow({ id: 2, slot: 1 })]]);

		const rows = await ensureThisMonthQuests(1);

		// 2 upserts (ON DUPLICATE KEY UPDATE) + 1 SELECT
		expect(mockedDb.query).toHaveBeenCalledTimes(3);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, 0, expect.any(String), expect.any(Number), expect.any(Number), expect.any(Number)],
		);
		expect(rows).toHaveLength(2);
	});
});

describe("getMonthlyQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to the client-facing shape, including claimed status", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([
			[templateRow({ progress: 1, claimed_at: null }), templateRow({ id: 2, claimed_at: "2026-09-05T10:00:00Z" })],
		]);

		const result = await getMonthlyQuests(1);

		expect(result.quests).toEqual([
			expect.objectContaining({ id: 1, progress: 1, claimed: false }),
			expect.objectContaining({ id: 2, claimed: true }),
		]);
		expect(result.resets_at).toBeTruthy();
	});
});

describe("progressForMatch", () => {
	beforeEach(() => vi.clearAllMocks());

	const queueEnsureThisMonthQuests = (rows: unknown[]) => {
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([rows]);
	};

	it("increments a 'play' quest regardless of mode or outcome", async () => {
		const playTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: playTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("increments a 'win' quest on any win", async () => {
		const winTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "win")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: winTemplate.code, progress: 0, target: winTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "solo", true);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("increments a 'win_network' quest on a network win only", async () => {
		const networkTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "win_network")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: networkTemplate.code, progress: 0, target: networkTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "ranked", true);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("does not increment a 'win_network' quest on a solo win", async () => {
		const networkTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "win_network")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: networkTemplate.code, progress: 0, target: networkTemplate.target })]);

		await progressForMatch(1, "solo", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("increments a 'play_race' quest by the number of cards played of that race", async () => {
		const raceTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play_race" && t.race === "Demon")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: raceTemplate.code, progress: 0, target: raceTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "solo", false, { cardsPlayedByRace: { Demon: 5, Human: 2 } });

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[5, 1],
		);
	});

	it("skips quests already at their target or already claimed", async () => {
		const playTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureThisMonthQuests([
			templateRow({ id: 1, quest_code: playTemplate.code, progress: playTemplate.target, target: playTemplate.target }),
			templateRow({ id: 2, quest_code: playTemplate.code, progress: 0, target: playTemplate.target, claimed_at: "2026-09-05T00:00:00Z" }),
		]);

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("claimMonthlyQuest", () => {
	beforeEach(() => vi.clearAllMocks());

	const makeConnection = (selectResult: unknown[]) => ({
		query: vi.fn().mockResolvedValueOnce([selectResult]).mockResolvedValue([{}]),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	});

	it("throws MonthlyQuestNotFoundError when the quest doesn't belong to this user", async () => {
		const connection = makeConnection([]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimMonthlyQuest(1, 999)).rejects.toThrow(MonthlyQuestNotFoundError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
	});

	it("throws MonthlyQuestAlreadyClaimedError on a second claim", async () => {
		const connection = makeConnection([templateRow({ claimed_at: "2026-09-05T00:00:00Z" })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimMonthlyQuest(1, 1)).rejects.toThrow(MonthlyQuestAlreadyClaimedError);
	});

	it("throws MonthlyQuestNotCompletedError when progress hasn't reached target", async () => {
		const connection = makeConnection([templateRow({ progress: 0, target: 100 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimMonthlyQuest(1, 1)).rejects.toThrow(MonthlyQuestNotCompletedError);
	});

	it("marks the quest claimed and credits currency + free_packs in a committed transaction", async () => {
		const connection = makeConnection([templateRow({ progress: 100, target: 100, reward_currency: 500, reward_pack: 2 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1500);
		mockedGetFreePacks.mockResolvedValueOnce(4);

		const result = await claimMonthlyQuest(1, 1);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [1]);
		expect(mockedCredit).toHaveBeenCalledWith(1, 500, "monthly_quest", "1", connection);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, 2, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ balance: 1500, free_packs: 4, reward_currency: 500, reward_pack: 2 });
	});
});
