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
	ONBOARDING_QUEST_TEMPLATES,
	ONBOARDING_LEVEL_CAP,
	OnboardingQuestNotFoundError,
	OnboardingQuestNotCompletedError,
	OnboardingQuestAlreadyClaimedError,
	ensureOnboardingQuests,
	getOnboardingQuests,
	progressForMatch,
	progressForPackPurchase,
	progressForLevel,
	claimOnboardingQuest,
} from "./onboardingQuestModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;
const mockedGetFreePacks = getFreePacks as ReturnType<typeof vi.fn>;

const templateRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 1,
	user_id: 1,
	quest_code: ONBOARDING_QUEST_TEMPLATES[0].code,
	progress: 0,
	target: ONBOARDING_QUEST_TEMPLATES[0].target,
	reward_currency: ONBOARDING_QUEST_TEMPLATES[0].rewardCurrency,
	reward_pack: ONBOARDING_QUEST_TEMPLATES[0].rewardPack,
	claimed_at: null,
	...overrides,
});

const TEMPLATE_COUNT = ONBOARDING_QUEST_TEMPLATES.length;

const queueEnsureOnboardingQuests = (rows: unknown[]) => {
	mockedDb.query.mockResolvedValueOnce([{}]);
	mockedDb.query.mockResolvedValueOnce([rows]);
};

describe("ensureOnboardingQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts the full catalogue then returns every quest for the user", async () => {
		queueEnsureOnboardingQuests([templateRow()]);

		const rows = await ensureOnboardingQuests(1, 3);

		expect(mockedDb.query).toHaveBeenCalledTimes(2);
		const [, [insertedRows]] = mockedDb.query.mock.calls[0];
		expect(insertedRows).toHaveLength(TEMPLATE_COUNT);
		expect(rows).toHaveLength(1);
	});

	it("backfills reach_level quests already passed at insertion time", async () => {
		queueEnsureOnboardingQuests([templateRow()]);

		await ensureOnboardingQuests(1, 12);

		const [, [insertedRows]] = mockedDb.query.mock.calls[0];
		const level5 = ONBOARDING_QUEST_TEMPLATES.findIndex((t) => t.code === "reach_level_5");
		const level15 = ONBOARDING_QUEST_TEMPLATES.findIndex((t) => t.code === "reach_level_15");
		expect(insertedRows[level5][2]).toBe(1); // progress = target (1) : niveau 12 >= 5
		expect(insertedRows[level15][2]).toBe(0); // niveau 12 < 15
	});
});

describe("getOnboardingQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the full catalogue (completed or not) below the level cap", async () => {
		queueEnsureOnboardingQuests([
			templateRow({ id: 1, progress: 0, claimed_at: null }),
			templateRow({ id: 2, progress: 1, target: 1, claimed_at: null }),
		]);

		const result = await getOnboardingQuests(1, 10);

		expect(result.quests).toHaveLength(2);
	});

	it("hides incomplete quests once the player is past the level cap, keeping completed ones", async () => {
		queueEnsureOnboardingQuests([
			templateRow({ id: 1, progress: 0, target: 1, claimed_at: null }),
			templateRow({ id: 2, progress: 1, target: 1, claimed_at: null }),
		]);

		const result = await getOnboardingQuests(1, ONBOARDING_LEVEL_CAP + 1);

		expect(result.quests).toEqual([expect.objectContaining({ id: 2, progress: 1, claimed: false })]);
	});
});

describe("progressForMatch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("increments a 'win' quest only on a win", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.objective === "win")!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForMatch(1, 5, "solo", true);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = LEAST"), [1]);
	});

	it("does not increment 'win' on a loss", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.objective === "win")!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);

		await progressForMatch(1, 5, "solo", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("increments 'win_ranked' only on a ranked win", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.objective === "win_ranked")!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForMatch(1, 5, "ranked", true);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = LEAST"), [1]);
	});

	it("increments 'play_network' on any network match, win or lose", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.objective === "play_network")!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForMatch(1, 5, "ranked", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = LEAST"), [1]);
	});

	it("does not increment 'play_network' on a solo match", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.objective === "play_network")!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);

		await progressForMatch(1, 5, "solo", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("skips quests already at their target or already claimed", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.objective === "win")!;
		queueEnsureOnboardingQuests([
			templateRow({ id: 1, quest_code: template.code, progress: template.target, target: template.target }),
			templateRow({ id: 2, quest_code: template.code, progress: 0, target: template.target, claimed_at: "2026-08-24T00:00:00Z" }),
		]);

		await progressForMatch(1, 5, "solo", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("progressForPackPurchase", () => {
	beforeEach(() => vi.clearAllMocks());

	it("increments the 'buy_packs' quest", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.objective === "buy_packs" && t.target === 1)!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForPackPurchase(1, 5);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = LEAST"), [1]);
	});
});

describe("progressForLevel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("completes the matching 'reach_level' quest once the level is high enough", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.code === "reach_level_10")!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForLevel(1, 10);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = target"), [1]);
	});

	it("does not complete a higher reach_level quest yet", async () => {
		const template = ONBOARDING_QUEST_TEMPLATES.find((t) => t.code === "reach_level_25")!;
		queueEnsureOnboardingQuests([templateRow({ quest_code: template.code, progress: 0, target: template.target })]);

		await progressForLevel(1, 10);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("claimOnboardingQuest", () => {
	beforeEach(() => vi.clearAllMocks());

	const makeConnection = (selectResult: unknown[]) => ({
		query: vi.fn().mockResolvedValueOnce([selectResult]).mockResolvedValue([{}]),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	});

	it("throws OnboardingQuestNotFoundError when the quest doesn't belong to this user", async () => {
		const connection = makeConnection([]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimOnboardingQuest(1, 999)).rejects.toThrow(OnboardingQuestNotFoundError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
	});

	it("throws OnboardingQuestAlreadyClaimedError on a second claim", async () => {
		const connection = makeConnection([templateRow({ claimed_at: "2026-08-24T00:00:00Z" })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimOnboardingQuest(1, 1)).rejects.toThrow(OnboardingQuestAlreadyClaimedError);
	});

	it("throws OnboardingQuestNotCompletedError when progress hasn't reached target", async () => {
		const connection = makeConnection([templateRow({ progress: 0, target: 1 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimOnboardingQuest(1, 1)).rejects.toThrow(OnboardingQuestNotCompletedError);
	});

	it("credits both gold and free packs when the quest rewards both, in a committed transaction", async () => {
		const connection = makeConnection([templateRow({ progress: 1, target: 1, reward_currency: 150, reward_pack: 1 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1500);
		mockedGetFreePacks.mockResolvedValueOnce(2);

		const result = await claimOnboardingQuest(1, 1);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [1]);
		expect(mockedCredit).toHaveBeenCalledWith(1, 150, "onboarding_quest_claim", "1", connection);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, 1, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ balance: 1500, free_packs: 2, reward_currency: 150, reward_pack: 1 });
	});

	it("does not credit free packs when reward_pack is 0", async () => {
		const connection = makeConnection([templateRow({ progress: 1, target: 1, reward_currency: 100, reward_pack: 0 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(800);
		mockedGetFreePacks.mockResolvedValueOnce(0);

		await claimOnboardingQuest(1, 1);

		expect(mockedCreditFreePacks).not.toHaveBeenCalled();
	});
});
