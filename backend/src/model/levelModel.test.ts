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
import { xpToReachNextLevel, applyXp } from "./levelModel";

const mockedGrantCard = grantCard as ReturnType<typeof vi.fn>;
const mockedGetOwnedQuantity = getOwnedQuantity as ReturnType<typeof vi.fn>;
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;

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
	it("grows 5% per level over the previous (rounded) threshold, starting at 100", () => {
		expect(xpToReachNextLevel(1)).toBe(100);
		expect(xpToReachNextLevel(2)).toBe(105); // round(100 * 1.05)
		expect(xpToReachNextLevel(3)).toBe(110); // round(105 * 1.05)
		expect(xpToReachNextLevel(9)).toBe(148);
		expect(xpToReachNextLevel(24)).toBe(307);
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
		expect(result.xp).toBe(40); // 90 + 50 - 100 (xpToReachNextLevel(1))
		expect(mockedCredit).toHaveBeenCalledWith(1, 20, "level_reward_gold", "level_2", connection);
		expect(result.rewards).toEqual([{ level: 2, type: "gold", gold: 20 }]);
	});

	it("grants a random Commune card at level 5", async () => {
		const connection = makeConnection({ level: 4, xp: 0 }, { Commune: [{ id: 7, rarity: "Commune" }] });
		const result = await applyXp(2, xpToReachNextLevel(4), connection);

		expect(result.level).toBe(5);
		expect(mockedGrantCard).toHaveBeenCalledWith(2, 7, 1, connection);
		expect(result.rewards).toEqual([
			{ level: 5, type: "card", card: { id: 7, rarity: "Commune" }, dusted: false },
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
		expect(result.rewards).toEqual([{ level: 25, type: "pack" }]);
	});

	it("dusts a card already owned at MAX_COPIES_PER_CARD instead of granting a 5th copy", async () => {
		mockedGetOwnedQuantity.mockResolvedValueOnce(4);
		const connection = makeConnection({ level: 9, xp: 0 }, { Rare: [{ id: 8, rarity: "Rare" }] });

		const result = await applyXp(4, xpToReachNextLevel(9), connection);

		expect(mockedGrantCard).not.toHaveBeenCalled();
		expect(mockedCredit).toHaveBeenCalledWith(4, 50, "level_reward_dust", "level_10", connection);
		expect(result.rewards).toEqual([
			{ level: 10, type: "card", card: { id: 8, rarity: "Rare" }, dusted: true, gold: 50 },
		]);
	});

	it("falls back to a gold reward if no card exists for the target rarity", async () => {
		const connection = makeConnection({ level: 14, xp: 0 }); // pas de carte Épique fournie
		const result = await applyXp(5, xpToReachNextLevel(14), connection);

		expect(result.level).toBe(15);
		expect(mockedCredit).toHaveBeenCalledWith(5, 20, "level_reward_gold", "level_15", connection);
		expect(result.rewards).toEqual([{ level: 15, type: "gold", gold: 20 }]);
	});

	it("grants a reward for every level crossed in a single large XP gain", async () => {
		const connection = makeConnection({ level: 1, xp: 0 });
		// xpToReachNextLevel(1)=100, (2)=105 : 205 XP franchit pile les niveaux 2 et 3.
		const result = await applyXp(6, 205, connection);

		expect(result.level).toBe(3);
		expect(result.xp).toBe(0);
		expect(result.rewards.map((r) => r.level)).toEqual([2, 3]);
	});
});
