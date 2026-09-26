import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

vi.mock("./collectionModel", () => ({
	grantCard: vi.fn(),
	getOwnedQuantity: vi.fn().mockResolvedValue(0),
	MAX_COPIES_PER_CARD: 4,
	DUST_VALUE_BY_RARITY: { Commune: 25, Rare: 50, "Épique": 75, "Légendaire": 100 },
}));

vi.mock("./currencyModel", () => ({
	credit: vi.fn(),
	creditFreePacks: vi.fn(),
}));

import { grantCard, getOwnedQuantity } from "./collectionModel";
import { credit, creditFreePacks } from "./currencyModel";
import db from "./db";
import { xpToReachNextLevel, applyXp, getRewardCatalog, getUserRewards, claimRewards } from "./levelModel";

const mockedGrantCard = grantCard as ReturnType<typeof vi.fn>;
const mockedGetOwnedQuantity = getOwnedQuantity as ReturnType<typeof vi.fn>;
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;
const mockedDbQuery = db.query as ReturnType<typeof vi.fn>;

// Connexion factice : route la SELECT level/xp vers `levelRow`, la SELECT de
// cartes par rareté vers `cardsByRarity[rarity]` (tableau vide par défaut,
// simule "aucune carte de cette rareté en base"), et répond un succès
// générique à tout le reste (UPDATE users...).
const makeConnection = (
	levelRow: { level: number; xp: number },
	cardsByRarity: Record<string, { id: number; rarity: string }[]> = {},
) => {
	const connection = {
		query: vi.fn(),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	};
	connection.query.mockImplementation((sql: unknown, params?: unknown[]) => {
		if (typeof sql === "string" && sql.includes("SELECT level, xp FROM users")) {
			return Promise.resolve([[levelRow]]);
		}
		if (typeof sql === "string" && sql.includes("SELECT * FROM cards WHERE rarity")) {
			const rarity = (params as unknown[])[0] as string;
			return Promise.resolve([cardsByRarity[rarity] ?? []]);
		}
		return Promise.resolve([{}]);
	});
	return connection as unknown as Parameters<typeof applyXp>[2];
};

describe("xpToReachNextLevel", () => {
	it("grows linearly, +5 XP per level over 100", () => {
		expect(xpToReachNextLevel(1)).toBe(105);
		expect(xpToReachNextLevel(2)).toBe(110);
		expect(xpToReachNextLevel(3)).toBe(115);
		expect(xpToReachNextLevel(9)).toBe(145);
		expect(xpToReachNextLevel(24)).toBe(220);
	});
});

describe("applyXp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedGetOwnedQuantity.mockResolvedValue(0);
	});

	it("accumulates XP without leveling up when below the threshold", async () => {
		const connection = makeConnection({ level: 1, xp: 20 });
		const result = await applyXp(1, 30, connection);

		expect(result.level).toBe(1);
		expect(result.xp).toBe(50);
		expect(result.rewards).toEqual([]);
	});

	it("grants a flat gold reward on a level not divisible by 5", async () => {
		const connection = makeConnection({ level: 1, xp: 90 });
		const result = await applyXp(1, 50, connection);

		expect(result.level).toBe(2);
		expect(result.xp).toBe(35); // 90 + 50 - 105 (xpToReachNextLevel(1))
		expect(mockedCredit).toHaveBeenCalledWith(1, 50, "level_reward_gold", "level_2", connection); // 2e palier d'or (level % 5 === 2)
		expect(result.rewards).toEqual([{ level: 2, type: "gold", gold: 50 }]);
	});

	it("ramps the gold-only reward 25/50/75/100 across a streak, then resets to 25 after a card level", async () => {
		mockedGetOwnedQuantity.mockResolvedValue(0);
		const cardsByRarity = { Commune: [{ id: 42, rarity: "Commune" }] };
		const goldRewards: number[] = [];

		for (let startLevel = 0; startLevel <= 5; startLevel++) {
			const connection = makeConnection({ level: startLevel, xp: 0 }, cardsByRarity);
			const result = await applyXp(9, xpToReachNextLevel(startLevel), connection);
			const reward = result.rewards[0];
			goldRewards.push(reward.type === "gold" ? reward.gold! : -1); // -1 = palier carte (level 5)
		}

		expect(goldRewards).toEqual([25, 50, 75, 100, -1, 25]);
	});

	it("grants a random Commune card at level 5", async () => {
		const connection = makeConnection({ level: 4, xp: 0 }, { Commune: [{ id: 7, rarity: "Commune" }] });
		const result = await applyXp(2, xpToReachNextLevel(4), connection);

		expect(result.level).toBe(5);
		expect(mockedGrantCard).toHaveBeenCalledWith(2, 7, 1, connection);
		expect(mockedCredit).toHaveBeenCalledWith(2, 100, "level_reward_gold", "level_5", connection);
		expect(result.rewards).toEqual([
			{ level: 5, type: "card", card: { id: 7, rarity: "Commune" }, dusted: false, gold: 100 },
		]);
	});

	it("cycles card rarity by level mod 20: 10 -> Rare, 15 -> Épique, 20 -> Légendaire", async () => {
		const connRare = makeConnection({ level: 9, xp: 0 }, { Rare: [{ id: 1, rarity: "Rare" }] });
		expect((await applyXp(1, xpToReachNextLevel(9), connRare)).rewards[0]).toMatchObject({
			level: 10,
			type: "card",
			card: { id: 1 },
		});

		const connEpic = makeConnection({ level: 14, xp: 0 }, { "Épique": [{ id: 2, rarity: "Épique" }] });
		expect((await applyXp(1, xpToReachNextLevel(14), connEpic)).rewards[0]).toMatchObject({
			level: 15,
			type: "card",
			card: { id: 2 },
		});

		const connLegendary = makeConnection({ level: 19, xp: 0 }, { "Légendaire": [{ id: 3, rarity: "Légendaire" }] });
		expect((await applyXp(1, xpToReachNextLevel(19), connLegendary)).rewards[0]).toMatchObject({
			level: 20,
			type: "card",
			card: { id: 3 },
		});
	});

	it("grants a free pack at level 25, overriding the 'multiple of 5' card rule", async () => {
		const connection = makeConnection({ level: 24, xp: 0 });
		const result = await applyXp(3, xpToReachNextLevel(24), connection);

		expect(result.level).toBe(25);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(3, 1, connection);
		expect(mockedGrantCard).not.toHaveBeenCalled();
		expect(mockedCredit).toHaveBeenCalledWith(3, 200, "level_reward_gold", "level_25", connection);
		expect(result.rewards).toEqual([{ level: 25, type: "pack", gold: 200 }]);
	});

	it("dusts a card already owned at MAX_COPIES_PER_CARD instead of granting a 5th copy", async () => {
		mockedGetOwnedQuantity.mockResolvedValueOnce(4);
		const connection = makeConnection({ level: 9, xp: 0 }, { Rare: [{ id: 8, rarity: "Rare" }] });

		const result = await applyXp(4, xpToReachNextLevel(9), connection);

		expect(mockedGrantCard).not.toHaveBeenCalled();
		expect(mockedCredit).toHaveBeenCalledWith(4, 150, "level_reward_dust", "level_10", connection); // 50 (dust Rare) + 100 (bonus palier)
		expect(result.rewards).toEqual([
			{ level: 10, type: "card", card: { id: 8, rarity: "Rare" }, dusted: true, gold: 150 },
		]);
	});

	it("falls back to a gold reward if no card exists for the target rarity", async () => {
		const connection = makeConnection({ level: 14, xp: 0 }); // pas de carte Épique fournie
		const result = await applyXp(5, xpToReachNextLevel(14), connection);

		expect(result.level).toBe(15);
		expect(mockedCredit).toHaveBeenCalledWith(5, 100, "level_reward_gold", "level_15", connection);
		expect(result.rewards).toEqual([{ level: 15, type: "gold", gold: 100 }]);
	});

	it("grants a reward for every level crossed in a single large XP gain", async () => {
		const connection = makeConnection({ level: 1, xp: 0 });
		// xpToReachNextLevel(1)=105, (2)=110 : 215 XP franchit pile les niveaux 2 et 3.
		const result = await applyXp(6, 215, connection);

		expect(result.level).toBe(3);
		expect(result.xp).toBe(0);
		expect(result.rewards.map((r) => r.level)).toEqual([2, 3]);
	});
});

describe("getRewardCatalog", () => {
	it("is deterministic and matches rewardKindForLevel", () => {
		const catalog = getRewardCatalog(1);
		expect(catalog[0]).toEqual({ level: 2, kind: "gold", gold: 50 });
		expect(catalog.find((entry) => entry.level === 5)).toEqual({ level: 5, kind: "card", rarity: "Commune" });
		expect(catalog.find((entry) => entry.level === 25)).toEqual({ level: 25, kind: "pack" });
		expect(catalog.at(-1)!.level).toBe(60); // CATALOG_MIN_LEVEL
	});

	it("extends past the player's current level by the lookahead margin", () => {
		const catalog = getRewardCatalog(80);
		expect(catalog.at(-1)!.level).toBe(90); // CATALOG_MIN_LEVEL n'est plus le plafond ici
	});
});

describe("getUserRewards", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps rows to a claimed boolean derived from claimed_at", async () => {
		mockedDbQuery.mockResolvedValueOnce([
			[
				{ level: 2, type: "gold", gold: 50, claimed_at: null },
				{ level: 3, type: "gold", gold: 75, claimed_at: "2026-09-20 10:00:00" },
			],
		]);
		expect(await getUserRewards(1)).toEqual([
			{ level: 2, type: "gold", gold: 50, claimed: false },
			{ level: 3, type: "gold", gold: 75, claimed: true },
		]);
	});
});

describe("claimRewards", () => {
	beforeEach(() => vi.clearAllMocks());

	it("skips the query entirely for an empty or invalid level list", async () => {
		expect(await claimRewards(1, [])).toEqual([]);
		expect(mockedDbQuery).not.toHaveBeenCalled();
	});

	it("returns only the levels actually marked claimed", async () => {
		mockedDbQuery
			.mockResolvedValueOnce([{ affectedRows: 2 }])
			.mockResolvedValueOnce([[{ level: 2 }, { level: 3 }]]);
		expect(await claimRewards(1, [2, 3])).toEqual([2, 3]);
	});

	it("returns an empty array when nothing was updated (already claimed)", async () => {
		mockedDbQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);
		expect(await claimRewards(1, [2])).toEqual([]);
	});
});
