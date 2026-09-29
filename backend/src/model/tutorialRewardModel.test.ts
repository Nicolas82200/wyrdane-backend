import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("./collectionModel", () => ({
	grantCard: vi.fn(),
	getOwnedQuantity: vi.fn(),
	MAX_COPIES_PER_CARD: 4,
	DUST_VALUE_BY_RARITY: { Commune: 5, Rare: 20, "Épique": 60, "Légendaire": 200 },
}));
vi.mock("./currencyModel", () => ({
	credit: vi.fn(),
	getBalance: vi.fn(),
}));

import db from "./db";
import { grantCard, getOwnedQuantity } from "./collectionModel";
import { credit, getBalance } from "./currencyModel";
import { TUTORIAL_REWARD_CARDS, TUTORIAL_RARITY_WEIGHTS, pickByRarity, claimTutorialReward } from "./tutorialRewardModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedGrantCard = grantCard as ReturnType<typeof vi.fn>;
const mockedGetOwnedQuantity = getOwnedQuantity as ReturnType<typeof vi.fn>;
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;

const card = (id: number, rarity: string) => ({ id, name: `carte-${id}`, rarity, card_type: "Minion" });

const poolByRarity = () =>
	new Map<string, ReturnType<typeof card>[]>([
		["Commune", [card(1, "Commune"), card(2, "Commune")]],
		["Rare", [card(3, "Rare")]],
		["Épique", [card(4, "Épique")]],
		["Légendaire", [card(5, "Légendaire")]],
	]);

describe("TUTORIAL_RARITY_WEIGHTS", () => {
	it("matches the 40/30/20/10 split", () => {
		expect(TUTORIAL_RARITY_WEIGHTS).toEqual({ Commune: 40, Rare: 30, "Épique": 20, "Légendaire": 10 });
		expect(Object.values(TUTORIAL_RARITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
	});
});

describe("pickByRarity", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("picks the rarity by weight, independently of how many cards each rarity holds", () => {
		// 2 communes contre 1 de chaque autre rareté : un tirage pondéré par
		// CARTE (packModel.pickWeighted) déséquilibrerait le ratio, pas celui-ci.
		const pool = poolByRarity();
		vi.spyOn(Math, "random").mockReturnValueOnce(0.5).mockReturnValueOnce(0);
		// roll = 0.5 * 100 = 50 → Commune (40) épuisé, Rare (30) atteint.
		expect(pickByRarity(pool as never).rarity).toBe("Rare");
	});

	it("lands on Commune for a low roll", () => {
		vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0);
		expect(pickByRarity(poolByRarity() as never).rarity).toBe("Commune");
	});

	it("lands on Légendaire for the highest rolls", () => {
		vi.spyOn(Math, "random").mockReturnValueOnce(0.95).mockReturnValueOnce(0);
		expect(pickByRarity(poolByRarity() as never).rarity).toBe("Légendaire");
	});

	it("ignores a rarity with no card in the catalogue", () => {
		const pool = poolByRarity();
		pool.set("Commune", []);
		vi.spyOn(Math, "random").mockReturnValueOnce(0.01).mockReturnValueOnce(0);
		expect(pickByRarity(pool as never).rarity).toBe("Rare");
	});
});

describe("claimTutorialReward", () => {
	const connection = { query: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };

	beforeEach(() => {
		vi.clearAllMocks();
		mockedDb.getConnection.mockResolvedValue(connection);
		mockedGetBalance.mockResolvedValue(1000);
	});

	it("returns claimed:false without granting anything when already claimed", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ tutorial_reward_claimed_at: "2026-01-01 00:00:00" }]]);

		const result = await claimTutorialReward(1);

		expect(result).toEqual({ claimed: false, cards: [], balance: 1000 });
		expect(mockedGrantCard).not.toHaveBeenCalled();
		expect(mockedDb.getConnection).not.toHaveBeenCalled();
	});

	it("grants exactly TUTORIAL_REWARD_CARDS cards and marks the claim", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ tutorial_reward_claimed_at: null }]]);
		mockedDb.query.mockResolvedValueOnce([[card(1, "Commune"), card(3, "Rare"), card(4, "Épique"), card(5, "Légendaire")]]);
		connection.query.mockResolvedValue([[{ tutorial_reward_claimed_at: null }]]);
		mockedGetOwnedQuantity.mockResolvedValue(0);

		const result = await claimTutorialReward(1);

		expect(result.claimed).toBe(true);
		expect(result.cards).toHaveLength(TUTORIAL_REWARD_CARDS);
		// Catalogue de test volontairement minuscule (4 cartes) : au-delà de
		// MAX_COPIES_PER_CARD exemplaires d'une même carte, le tirage bascule en
		// poussière — les deux chemins réunis couvrent toujours les 25 tirages.
		expect(mockedGrantCard.mock.calls.length + mockedCredit.mock.calls.length).toBe(TUTORIAL_REWARD_CARDS);
		expect(mockedGrantCard).toHaveBeenCalled();
		expect(connection.query).toHaveBeenLastCalledWith(expect.stringContaining("tutorial_reward_claimed_at = NOW()"), [1]);
		expect(connection.commit).toHaveBeenCalled();
	});

	it("dusts a copy beyond MAX_COPIES_PER_CARD instead of granting it", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ tutorial_reward_claimed_at: null }]]);
		mockedDb.query.mockResolvedValueOnce([[card(1, "Commune")]]);
		connection.query.mockResolvedValue([[{ tutorial_reward_claimed_at: null }]]);
		mockedGetOwnedQuantity.mockResolvedValue(4);

		const result = await claimTutorialReward(1);

		expect(mockedGrantCard).not.toHaveBeenCalled();
		expect(mockedCredit).toHaveBeenCalledTimes(TUTORIAL_REWARD_CARDS);
		expect(result.cards.every((c) => c.dusted)).toBe(true);
	});

	it("rolls back if a grant fails mid-way", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ tutorial_reward_claimed_at: null }]]);
		mockedDb.query.mockResolvedValueOnce([[card(1, "Commune")]]);
		connection.query.mockResolvedValue([[{ tutorial_reward_claimed_at: null }]]);
		mockedGetOwnedQuantity.mockResolvedValue(0);
		mockedGrantCard.mockRejectedValueOnce(new Error("db exploded"));

		await expect(claimTutorialReward(1)).rejects.toThrow("db exploded");
		expect(connection.rollback).toHaveBeenCalled();
		expect(connection.commit).not.toHaveBeenCalled();
	});
});
