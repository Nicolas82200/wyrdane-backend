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
vi.mock("./levelModel", () => ({
	applyXp: vi.fn(),
}));

import db from "./db";
import { credit, getBalance } from "./currencyModel";
import {
	QUEST_TEMPLATES,
	QUESTS_PER_DAY,
	QuestNotFoundError,
	QuestNotCompletedError,
	QuestAlreadyClaimedError,
	ensureTodayQuests,
	getDailyQuests,
	progressForMatch,
	progressForLogin,
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
	reward_xp: QUEST_TEMPLATES[0].rewardXp,
	claimed_at: null,
	...overrides,
});

describe("ensureTodayQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts QUESTS_PER_DAY quests then returns them for the day", async () => {
		for (let slot = 0; slot < QUESTS_PER_DAY; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([
			[templateRow({ slot: 0 }), templateRow({ id: 2, slot: 1 }), templateRow({ id: 3, slot: 2 })],
		]);

		const rows = await ensureTodayQuests(1);

		// QUESTS_PER_DAY upserts (ON DUPLICATE KEY UPDATE) + 1 SELECT
		expect(mockedDb.query).toHaveBeenCalledTimes(QUESTS_PER_DAY + 1);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, 0, expect.any(String), expect.any(Number), expect.any(Number), expect.any(Number)],
		);
		expect(rows).toHaveLength(3);
	});
});

describe("getDailyQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to the client-facing shape, including claimed status", async () => {
		for (let slot = 0; slot < QUESTS_PER_DAY; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([
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

	// ensureTodayQuests fait QUESTS_PER_DAY upserts (un par slot) puis 1 SELECT
	// avant que progressForMatch n'examine les résultats — on doit mettre en
	// file autant de réponses d'upsert (peu importe leur contenu) avant la
	// ligne du SELECT.
	const queueEnsureTodayQuests = (rows: unknown[]) => {
		for (let slot = 0; slot < QUESTS_PER_DAY; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([rows]);
	};

	const playTemplate = QUEST_TEMPLATES.find((t) => t.objective === "play")!;
	const winTemplate = QUEST_TEMPLATES.find((t) => t.objective === "win")!;
	const resourceTemplate = QUEST_TEMPLATES.find((t) => t.objective === "play_resource_race" && t.race === "Demon")!;

	it("increments a 'play' quest on an matched multiplayer match, won or lost", async () => {
		queueEnsureTodayQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: playTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "normal", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	// Le coeur de la décision produit du 2026-11-02 : ni l'IA ni une partie sur
	// invitation d'ami ne font progresser les quêtes de parties.
	it.each(["solo", "friendly"] as const)("does not increment a 'play' quest in %s mode", async (mode) => {
		queueEnsureTodayQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: playTemplate.target })]);

		await progressForMatch(1, mode, true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("does not increment a 'win' quest on a defeat", async () => {
		queueEnsureTodayQuests([templateRow({ quest_code: winTemplate.code, progress: 0, target: winTemplate.target })]);

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("increments the resource quest by the number of resource cards of that race, in any mode", async () => {
		queueEnsureTodayQuests([
			templateRow({ quest_code: resourceTemplate.code, progress: 0, target: resourceTemplate.target }),
		]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		// Même en solo : rien n'empêche de jouer des ressources contre l'IA.
		await progressForMatch(1, "solo", false, { resourceCardsByRace: { Demon: 4, Human: 2 } });

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[4, 1],
		);
	});

	// Garde-fou du découplage : les ressources sont comptées à part, un
	// serviteur Démon ne valide pas la quête des Âmes.
	it("ignores non-resource cards of the same race", async () => {
		queueEnsureTodayQuests([
			templateRow({ quest_code: resourceTemplate.code, progress: 0, target: resourceTemplate.target }),
		]);

		await progressForMatch(1, "ranked", false, { cardsPlayedByRace: { Demon: 9 } });

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("skips quests that are already at their target or already claimed", async () => {
		queueEnsureTodayQuests([
			templateRow({ id: 1, quest_code: playTemplate.code, progress: playTemplate.target, target: playTemplate.target }),
			templateRow({ id: 2, quest_code: playTemplate.code, progress: 0, target: playTemplate.target, claimed_at: "2026-08-17T00:00:00Z" }),
		]);

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("progressForLogin", () => {
	beforeEach(() => vi.clearAllMocks());

	const loginTemplate = QUEST_TEMPLATES.find((t) => t.objective === "login")!;

	const queueEnsureTodayQuests = (rows: unknown[]) => {
		for (let slot = 0; slot < QUESTS_PER_DAY; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([rows]);
	};

	it("completes the login quest outright", async () => {
		queueEnsureTodayQuests([templateRow({ quest_code: loginTemplate.code, progress: 0, target: 1 })]);
		mockedDb.query.mockResolvedValueOnce([{}]);

		await progressForLogin(1);

		expect(mockedDb.query).toHaveBeenLastCalledWith(expect.stringContaining("SET progress = target"), [1]);
	});

	it("leaves the other quests alone", async () => {
		const playTemplate = QUEST_TEMPLATES.find((t) => t.objective === "play")!;
		queueEnsureTodayQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: 3 })]);

		await progressForLogin(1);

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
		const connection = makeConnection([templateRow({ progress: 2, target: 2, reward_currency: 50, reward_xp: 0 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1050);

		const result = await claimQuest(1, 1);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [1]);
		expect(mockedCredit).toHaveBeenCalledWith(1, 50, "daily_quest_claim", "1", connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ balance: 1050, reward_currency: 50, reward_xp: 0 });
	});
});
