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
}));

import db from "./db";
import { credit, getBalance } from "./currencyModel";
import {
	QUEST_TEMPLATES,
	QuestNotFoundError,
	QuestNotCompletedError,
	QuestAlreadyClaimedError,
	ensureTodayQuests,
	getDailyQuests,
	progressForMatch,
	claimQuest,
} from "./questModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;

const templateRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 1,
	user_id: 1,
	quest_date: "2026-08-17",
	slot: 0,
	quest_code: QUEST_TEMPLATES[0].code,
	progress: 0,
	target: QUEST_TEMPLATES[0].target,
	reward_currency: QUEST_TEMPLATES[0].rewardCurrency,
	claimed_at: null,
	...overrides,
});

describe("ensureTodayQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts 3 quests then returns them for the day", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([
			[templateRow({ slot: 0 }), templateRow({ id: 2, slot: 1 }), templateRow({ id: 3, slot: 2 })],
		]);

		const rows = await ensureTodayQuests(1);

		// 3 upserts (ON DUPLICATE KEY UPDATE) + 1 SELECT
		expect(mockedDb.query).toHaveBeenCalledTimes(4);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, 0, expect.any(String), expect.any(Number), expect.any(Number)],
		);
		expect(rows).toHaveLength(3);
	});
});

describe("getDailyQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to the client-facing shape, including claimed status", async () => {
		mockedDb.query.mockResolvedValue([{}]);
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([
			[templateRow({ progress: 1, claimed_at: null }), templateRow({ id: 2, claimed_at: "2026-08-17T10:00:00Z" })],
		]);

		const result = await getDailyQuests(1);

		expect(result.quests).toEqual([
			expect.objectContaining({ id: 1, progress: 1, claimed: false }),
			expect.objectContaining({ id: 2, claimed: true }),
		]);
		expect(result.resets_at).toBeTruthy();
	});
});

describe("progressForMatch", () => {
	beforeEach(() => vi.clearAllMocks());

	// ensureTodayQuests fait 3 upserts (un par slot) puis 1 SELECT avant que
	// progressForMatch n'examine les résultats — on doit mettre en file les 3
	// réponses d'upsert (peu importe leur contenu) avant la ligne du SELECT.
	const queueEnsureTodayQuests = (rows: unknown[]) => {
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([rows]);
	};

	it("increments a 'play' quest regardless of the match outcome", async () => {
		const playTemplate = QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureTodayQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: playTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("does not increment a 'win' quest on a defeat", async () => {
		const winTemplate = QUEST_TEMPLATES.find((t) => t.objective === "win")!;
		queueEnsureTodayQuests([templateRow({ quest_code: winTemplate.code, progress: 0, target: winTemplate.target })]);

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("does not increment a 'win_ranked' quest on a solo win", async () => {
		const rankedTemplate = QUEST_TEMPLATES.find((t) => t.objective === "win_ranked")!;
		queueEnsureTodayQuests([templateRow({ quest_code: rankedTemplate.code, progress: 0, target: rankedTemplate.target })]);

		await progressForMatch(1, "solo", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("skips quests that are already at their target or already claimed", async () => {
		const playTemplate = QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureTodayQuests([
			templateRow({ id: 1, quest_code: playTemplate.code, progress: playTemplate.target, target: playTemplate.target }),
			templateRow({ id: 2, quest_code: playTemplate.code, progress: 0, target: playTemplate.target, claimed_at: "2026-08-17T00:00:00Z" }),
		]);

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("claimQuest", () => {
	beforeEach(() => vi.clearAllMocks());

	const makeConnection = (selectResult: unknown[]) => ({
		query: vi.fn().mockResolvedValueOnce([selectResult]).mockResolvedValue([{}]),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	});

	it("throws QuestNotFoundError when the quest doesn't belong to this user", async () => {
		const connection = makeConnection([]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimQuest(1, 999)).rejects.toThrow(QuestNotFoundError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
	});

	it("throws QuestAlreadyClaimedError on a second claim", async () => {
		const connection = makeConnection([templateRow({ claimed_at: "2026-08-17T00:00:00Z" })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimQuest(1, 1)).rejects.toThrow(QuestAlreadyClaimedError);
	});

	it("throws QuestNotCompletedError when progress hasn't reached target", async () => {
		const connection = makeConnection([templateRow({ progress: 0, target: 3 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimQuest(1, 1)).rejects.toThrow(QuestNotCompletedError);
	});

	it("marks the quest claimed and credits the reward in a committed transaction", async () => {
		const connection = makeConnection([templateRow({ progress: 2, target: 2, reward_currency: 50 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1050);

		const result = await claimQuest(1, 1);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [1]);
		expect(mockedCredit).toHaveBeenCalledWith(1, 50, "daily_quest_claim", "1", connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ balance: 1050, reward_currency: 50 });
	});
});
