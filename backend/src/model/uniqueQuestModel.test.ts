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
	UNIQUE_QUEST_TEMPLATES,
	UniqueQuestNotFoundError,
	UniqueQuestNotCompletedError,
	UniqueQuestAlreadyClaimedError,
	ensureUniqueQuests,
	getUniqueQuests,
	progressForMatch,
	progressForPackOpen,
	progressForRankTier,
	claimUniqueQuest,
} from "./uniqueQuestModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;
const mockedGetFreePacks = getFreePacks as ReturnType<typeof vi.fn>;

const templateRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 1,
	user_id: 1,
	quest_code: UNIQUE_QUEST_TEMPLATES[0].code,
	progress: 0,
	target: UNIQUE_QUEST_TEMPLATES[0].target,
	reward_currency: UNIQUE_QUEST_TEMPLATES[0].rewardCurrency,
	reward_pack: UNIQUE_QUEST_TEMPLATES[0].rewardPack,
	meta: null,
	claimed_at: null,
	...overrides,
});

// ensureUniqueQuests fait 1 upsert par template du catalogue puis 1 SELECT.
const TEMPLATE_COUNT = UNIQUE_QUEST_TEMPLATES.length;

const queueEnsureUniqueQuests = (rows: unknown[]) => {
	for (let i = 0; i < TEMPLATE_COUNT; i++) {
		mockedDb.query.mockResolvedValueOnce([{}]);
	}
	mockedDb.query.mockResolvedValueOnce([rows]);
};

describe("ensureUniqueQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts the full catalogue then returns every quest for the user", async () => {
		queueEnsureUniqueQuests([templateRow()]);

		const rows = await ensureUniqueQuests(1);

		expect(mockedDb.query).toHaveBeenCalledTimes(TEMPLATE_COUNT + 1);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, expect.any(String), expect.any(Number), expect.any(Number), expect.any(Number)],
		);
		expect(rows).toHaveLength(1);
	});
});

describe("getUniqueQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to the client-facing shape, including claimed status", async () => {
		queueEnsureUniqueQuests([
			templateRow({ progress: 1, claimed_at: null }),
			templateRow({ id: 2, claimed_at: "2026-08-24T10:00:00Z" }),
		]);

		const result = await getUniqueQuests(1);

		expect(result.quests).toEqual([
			expect.objectContaining({ id: 1, progress: 1, claimed: false }),
			expect.objectContaining({ id: 2, claimed: true }),
		]);
	});
});

describe("progressForMatch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("increments a 'play' quest regardless of mode or outcome", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureUniqueQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = LEAST"), [1]);
	});

	it("increments a 'win_ranked' quest only on a ranked win", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "win_ranked")!;
		queueEnsureUniqueQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForMatch(1, "ranked", true);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = LEAST"), [1]);
	});

	it("completes a 'play_race_first' quest the first time the race appears in the deck, win or lose", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "play_race_first" && t.race === "Demon")!;
		queueEnsureUniqueQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForMatch(1, "solo", false, { deckRaces: ["Demon", "Human"] });

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = target"), [1]);
	});

	it("completes 'first_multirace_win' only on a win with 2+ races", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "win_multirace_first")!;
		queueEnsureUniqueQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);

		await progressForMatch(1, "solo", true, { deckRaces: ["Demon"] });

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("accumulates distinct races into 'win_all_races' via meta, ignoring repeats", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "win_all_races")!;
		queueEnsureUniqueQuests([
			templateRow({ quest_code: template.code, progress: 1, target: template.target, meta: "Human" }),
		]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForMatch(1, "solo", true, { deckRaces: ["Human", "Demon"] });

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("progress = ?, meta = ?"),
			[2, "Human,Demon", 1],
		);
	});

	it("skips quests already at their target or already claimed", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureUniqueQuests([
			templateRow({ id: 1, quest_code: template.code, progress: template.target, target: template.target }),
			templateRow({ id: 2, quest_code: template.code, progress: 0, target: template.target, claimed_at: "2026-08-24T00:00:00Z" }),
		]);

		await progressForMatch(1, "solo", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("progressForPackOpen", () => {
	beforeEach(() => vi.clearAllMocks());

	it("increments the 'open_packs' quest", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "open_packs")!;
		queueEnsureUniqueQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForPackOpen(1);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = LEAST"), [1, 1]);
	});
});

describe("progressForRankTier", () => {
	beforeEach(() => vi.clearAllMocks());

	it("completes 'reach_gold' once mmr crosses the gold threshold", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "reach_tier" && t.tier === "gold")!;
		queueEnsureUniqueQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForRankTier(1, 1350);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = target"), [1]);
	});

	it("does not complete 'reach_legend' below its threshold", async () => {
		const template = UNIQUE_QUEST_TEMPLATES.find((t) => t.objective === "reach_tier" && t.tier === "legend")!;
		queueEnsureUniqueQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);

		await progressForRankTier(1, 1400);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("claimUniqueQuest", () => {
	beforeEach(() => vi.clearAllMocks());

	const makeConnection = (selectResult: unknown[]) => ({
		query: vi.fn().mockResolvedValueOnce([selectResult]).mockResolvedValue([{}]),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	});

	it("throws UniqueQuestNotFoundError when the quest doesn't belong to this user", async () => {
		const connection = makeConnection([]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimUniqueQuest(1, 999)).rejects.toThrow(UniqueQuestNotFoundError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
	});

	it("throws UniqueQuestAlreadyClaimedError on a second claim", async () => {
		const connection = makeConnection([templateRow({ claimed_at: "2026-08-24T00:00:00Z" })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimUniqueQuest(1, 1)).rejects.toThrow(UniqueQuestAlreadyClaimedError);
	});

	it("throws UniqueQuestNotCompletedError when progress hasn't reached target", async () => {
		const connection = makeConnection([templateRow({ progress: 0, target: 50 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimUniqueQuest(1, 1)).rejects.toThrow(UniqueQuestNotCompletedError);
	});

	it("credits both gold and free packs when the quest rewards both, in a committed transaction", async () => {
		const connection = makeConnection([templateRow({ progress: 4, target: 4, reward_currency: 500, reward_pack: 1 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1500);
		mockedGetFreePacks.mockResolvedValueOnce(2);

		const result = await claimUniqueQuest(1, 1);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [1]);
		expect(mockedCredit).toHaveBeenCalledWith(1, 500, "unique_quest_claim", "1", connection);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, 1, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ balance: 1500, free_packs: 2, reward_currency: 500, reward_pack: 1 });
	});

	it("does not credit free packs when reward_pack is 0", async () => {
		const connection = makeConnection([templateRow({ progress: 50, target: 50, reward_currency: 300, reward_pack: 0 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(800);
		mockedGetFreePacks.mockResolvedValueOnce(0);

		await claimUniqueQuest(1, 1);

		expect(mockedCreditFreePacks).not.toHaveBeenCalled();
	});
});
