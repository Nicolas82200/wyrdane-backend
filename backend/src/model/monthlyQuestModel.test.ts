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
	getFreePacksByRace: vi.fn(),
}));
vi.mock("./levelModel", () => ({
	applyXp: vi.fn(),
}));

import db from "./db";
import { credit, getBalance, creditFreePacks, getFreePacks, getFreePacksByRace } from "./currencyModel";
import { applyXp } from "./levelModel";
import {
	MONTHLY_QUEST_TEMPLATES,
	LOGIN_STREAK_TEMPLATE,
	MonthlyQuestNotFoundError,
	MonthlyQuestNotCompletedError,
	MonthlyQuestAlreadyClaimedError,
	ensureThisMonthQuests,
	getMonthlyQuests,
	QUESTS_PER_MONTH,
	progressForMatch,
	progressForLogin,
	progressForPackOpen,
	advanceRaceAllProgress,
	claimMonthlyQuest,
} from "./monthlyQuestModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;
const mockedGetFreePacks = getFreePacks as ReturnType<typeof vi.fn>;
const mockedGetFreePacksByRace = getFreePacksByRace as ReturnType<typeof vi.fn>;
const mockedApplyXp = applyXp as ReturnType<typeof vi.fn>;

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
	reward_xp: MONTHLY_QUEST_TEMPLATES[0].rewardXp,
	reward_pack_race: null,
	meta: null,
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
	reward_xp: LOGIN_STREAK_TEMPLATE.rewardXp,
	reward_pack_race: null,
	meta: null,
	last_progress_date: null,
	claimed_at: null,
	...overrides,
});

describe("ensureThisMonthQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("upserts every fixed quest plus the login quest, then returns them", async () => {
		for (let slot = 0; slot <= QUESTS_PER_MONTH; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([[templateRow({ slot: 0 }), templateRow({ id: 2, slot: 1 }), loginRow()]]);

		const rows = await ensureThisMonthQuests(1);

		// QUESTS_PER_MONTH upserts + 1 upsert fixe (login) + 1 SELECT
		expect(mockedDb.query).toHaveBeenCalledTimes(QUESTS_PER_MONTH + 2);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[1, 0, expect.any(String), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), null],
		);
		// La quête de connexion occupe toujours le dernier slot.
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			QUESTS_PER_MONTH + 1,
			expect.stringContaining("ON DUPLICATE KEY UPDATE"),
			[
				1,
				QUESTS_PER_MONTH,
				LOGIN_STREAK_TEMPLATE.code,
				LOGIN_STREAK_TEMPLATE.target,
				LOGIN_STREAK_TEMPLATE.rewardCurrency,
				LOGIN_STREAK_TEMPLATE.rewardPack,
				LOGIN_STREAK_TEMPLATE.rewardXp,
				null,
			],
		);
		expect(rows).toHaveLength(3);
	});
});

describe("getMonthlyQuests", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to the client-facing shape, including claimed status", async () => {
		for (let slot = 0; slot <= QUESTS_PER_MONTH; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([
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
		// QUESTS_PER_MONTH upserts + 1 pour la quête de connexion fixe
		for (let slot = 0; slot <= QUESTS_PER_MONTH; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([rows]);
	};

	const playTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play")!;
	const winTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "win")!;
	const multiraceTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play_multirace")!;
	const raceAllTemplate = MONTHLY_QUEST_TEMPLATES.find((t) => t.objective === "play_race_all")!;

	it("increments a 'play' quest on a matched multiplayer match, won or lost", async () => {
		queueEnsureThisMonthQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: playTemplate.target })]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	// Décision produit 2026-11-02 : ni l'IA ni une invitation d'ami ne comptent.
	it.each(["solo", "friendly"] as const)("does not increment a 'play' quest in %s mode", async (mode) => {
		queueEnsureThisMonthQuests([templateRow({ quest_code: playTemplate.code, progress: 0, target: playTemplate.target })]);

		await progressForMatch(1, mode, true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("does not increment a 'win' quest on a loss", async () => {
		queueEnsureThisMonthQuests([templateRow({ quest_code: winTemplate.code, progress: 0, target: winTemplate.target })]);

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("increments a 'play_multirace' quest only with a 2+ race deck", async () => {
		queueEnsureThisMonthQuests([
			templateRow({ quest_code: multiraceTemplate.code, progress: 0, target: multiraceTemplate.target }),
		]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "ranked", false, { deckRaces: ["Human", "Demon"] });

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = LEAST"),
			[1],
		);
	});

	it("does not increment a 'play_multirace' quest with a mono-race deck", async () => {
		queueEnsureThisMonthQuests([
			templateRow({ quest_code: multiraceTemplate.code, progress: 0, target: multiraceTemplate.target }),
		]);

		await progressForMatch(1, "ranked", false, { deckRaces: ["Human"] });

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("tracks play_race_all per race and writes the capped sum", async () => {
		queueEnsureThisMonthQuests([
			templateRow({
				quest_code: raceAllTemplate.code,
				progress: 0,
				target: raceAllTemplate.target,
				meta: { Undead: 10 },
			}),
		]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE progress

		await progressForMatch(1, "ranked", false, { cardsPlayedByRace: { Undead: 5, Demon: 2 } });

		expect(mockedDb.query).toHaveBeenLastCalledWith(
			expect.stringContaining("SET progress = ?, meta = ?"),
			[17, JSON.stringify({ Undead: 15, Human: 0, Demon: 2, Abomination: 0 }), 1],
		);
	});

	it("never touches the fixed login quest (only progressForLogin does)", async () => {
		queueEnsureThisMonthQuests([loginRow({ progress: 0, target: LOGIN_STREAK_TEMPLATE.target })]);

		await progressForMatch(1, "ranked", true);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});

	it("skips quests already at their target or already claimed", async () => {
		queueEnsureThisMonthQuests([
			templateRow({ id: 1, quest_code: playTemplate.code, progress: playTemplate.target, target: playTemplate.target }),
			templateRow({ id: 2, quest_code: playTemplate.code, progress: 0, target: playTemplate.target, claimed_at: "2026-09-05T00:00:00Z" }),
		]);

		await progressForMatch(1, "ranked", false);

		expect(mockedDb.query).not.toHaveBeenCalledWith(expect.stringContaining("SET progress"), expect.anything());
	});
});

describe("progressForLogin", () => {
	beforeEach(() => vi.clearAllMocks());

	const queueEnsureThisMonthQuests = (rows: unknown[]) => {
		// QUESTS_PER_MONTH upserts + 1 pour la quête de connexion fixe
		for (let slot = 0; slot <= QUESTS_PER_MONTH; slot++) {
			mockedDb.query.mockResolvedValueOnce([{}]);
		}
		mockedDb.query.mockResolvedValueOnce([rows]);
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

	it("marks the quest claimed and credits currency, packs and XP in a committed transaction", async () => {
		const connection = makeConnection([
			loginRow({ progress: LOGIN_STREAK_TEMPLATE.target, target: LOGIN_STREAK_TEMPLATE.target }),
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(2500);
		mockedGetFreePacks.mockResolvedValueOnce(6);
		mockedGetFreePacksByRace.mockResolvedValueOnce({ multirace: 6 });

		const result = await claimMonthlyQuest(1, 3);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [3, 1]);
		expect(connection.query).toHaveBeenNthCalledWith(2, expect.stringContaining("claimed_at = NOW()"), [3]);
		expect(mockedCredit).toHaveBeenCalledWith(1, LOGIN_STREAK_TEMPLATE.rewardCurrency, "monthly_quest", "3", connection);
		// La quête de connexion est la seule payée en XP.
		expect(mockedApplyXp).toHaveBeenCalledWith(1, LOGIN_STREAK_TEMPLATE.rewardXp, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			balance: 2500,
			free_packs: 6,
			reward_currency: LOGIN_STREAK_TEMPLATE.rewardCurrency,
			reward_pack: LOGIN_STREAK_TEMPLATE.rewardPack,
			reward_xp: LOGIN_STREAK_TEMPLATE.rewardXp,
			free_packs_by_race: { multirace: 6 },
		});
	});

	// La quête multirace paie en packs de race : "all" doit en créditer un par
	// race implémentée, en plus du pack multirace.
	it("credits one pack of every race when reward_pack_race is 'all'", async () => {
		const connection = makeConnection([
			templateRow({ progress: 25, target: 25, reward_currency: 0, reward_pack: 1, reward_pack_race: "all" }),
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(0);
		mockedGetFreePacks.mockResolvedValueOnce(5);
		mockedGetFreePacksByRace.mockResolvedValueOnce({});

		await claimMonthlyQuest(1, 1);

		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, 1, connection);
		for (const race of ["Undead", "Human", "Demon", "Abomination"]) {
			expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, 1, connection, race);
		}
		// Zéro or sur cette quête : jamais de crédit de monnaie.
		expect(mockedCredit).not.toHaveBeenCalled();
	});
});
