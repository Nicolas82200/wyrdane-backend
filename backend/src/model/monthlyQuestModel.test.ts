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
	LOGIN_STREAK_TEMPLATE,
	MonthlyQuestNotFoundError,
	MonthlyQuestNotCompletedError,
	MonthlyQuestAlreadyClaimedError,
	ensureThisMonthQuests,
	getMonthlyQuests,
	progressForMatch,
	progressForLogin,
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
	last_progress_date: null,
	claimed_at: null,
	...overrides,
});

const loginRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 3,
	user_id: 1,
	month_start: "2026-09-01",
	slot: 2,
	quest_code: LOGIN_STREAK_TEMPLATE.code,
	progress: 0,
	target: LOGIN_STREAK_TEMPLATE.target,
	reward_currency: LOGIN_STREAK_TEMPLATE.rewardCurrency,
	reward_pack: LOGIN_STREAK_TEMPLATE.rewardPack,
	last_progress_date: null,
	claimed_at: null,
	...overrides,
});

describe("ensureThisMonthQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts 2 rotating quests + 1 fixed login quest, then returns all 3", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[templateRow({ slot: 0 }), templateRow({ id: 2, slot: 1 }), loginRow()]]);

		const rows = await ensureThisMonthQuests(1);

		// 2 upserts tirés au sort + 1 upsert fixe (login) + 1 SELECT
		expect(mockedDb.query).toHaveBeenCalledTimes(4);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, 0, expect.any(String), expect.any(Number), expect.any(Number), expect.any(Number)],
		);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			3,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, 2, LOGIN_STREAK_TEMPLATE.code, LOGIN_STREAK_TEMPLATE.target, LOGIN_STREAK_TEMPLATE.rewardCurrency, LOGIN_STREAK_TEMPLATE.rewardPack],
		);
		expect(rows).toHaveLength(3);
	});
});

describe("getMonthlyQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to the client-facing shape, including claimed status", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([
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
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([rows]);
	};

	it("increments a 'play_network' quest on any network match, regardless of outcome", async () => {
		const template = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play_network")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("does not increment a 'play_network' quest on a solo match", async () => {
		const template = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play_network")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);

		await progressForMatch(1, "solo", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("increments a 'win_network' quest on a network win only", async () => {
		const template = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "win_network")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "ranked", true);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("does not increment a 'win_network' quest on a network loss", async () => {
		const template = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "win_network")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);

		await progressForMatch(1, "ranked", false);

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

	it("increments a 'play_multirace' quest only with a 2+ race deck", async () => {
		const template = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play_multirace")!;
		queueEnsureThisMonthQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "solo", false, { deckRaces: ["Human", "Demon"] });

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("never touches the fixed login quest (only progressForLogin does)", async () => {
		queueEnsureThisMonthQuests([loginRow({ progress: 0, target: LOGIN_STREAK_TEMPLATE.target })]);

		await progressForMatch(1, "ranked", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("skips quests already at their target or already claimed", async () => {
		const template = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play_network")!;
		queueEnsureThisMonthQuests([
			templateRow({ id: 1, quest_code: template.code, progress: template.target, target: template.target }),
			templateRow({ id: 2, quest_code: template.code, progress: 0, target: template.target, claimed_at: "2026-09-05T00:00:00Z" }),
		]);

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("progressForLogin", () => {
	beforeEach(() => vi.clearAllMocks());

	const queueEnsureThisMonthQuests = (rows: unknown[]) => {
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([rows]);
	};

	it("increments the login quest, guarded by last_progress_date in the UPDATE", async () => {
		queueEnsureThisMonthQuests([loginRow({ id: 3, progress: 5 })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForLogin(1);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("last_progress_date"),
			[3],
		);
	});

	it("does nothing if the login quest is already claimed or maxed", async () => {
		queueEnsureThisMonthQuests([loginRow({ id: 3, progress: LOGIN_STREAK_TEMPLATE.target, target: LOGIN_STREAK_TEMPLATE.target })]);

		await progressForLogin(1);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("last_progress_date"), expect.anything());
	});

	it("does nothing if there is no login quest this month (defensive)", async () => {
		queueEnsureThisMonthQuests([templateRow()]);

		await progressForLogin(1);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("last_progress_date"), expect.anything());
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
		const connection = makeConnection([loginRow({ progress: LOGIN_STREAK_TEMPLATE.target, target: LOGIN_STREAK_TEMPLATE.target })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(2500);
		mockedGetFreePacks.mockResolvedValueOnce(6);

		const result = await claimMonthlyQuest(1, 3);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [3, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [3]);
		expect(mockedCredit).toHaveBeenCalledWith(1, LOGIN_STREAK_TEMPLATE.rewardCurrency, "monthly_quest", "3", connection);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, LOGIN_STREAK_TEMPLATE.rewardPack, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			balance: 2500,
			free_packs: 6,
			reward_currency: LOGIN_STREAK_TEMPLATE.rewardCurrency,
			reward_pack: LOGIN_STREAK_TEMPLATE.rewardPack,
		});
	});
});
