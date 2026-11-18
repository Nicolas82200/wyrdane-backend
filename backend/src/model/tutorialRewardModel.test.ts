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
import {
	TUTORIAL_REWARD_CARDS,
	TUTORIAL_REWARD_RARITY_COUNTS,
	rewardRaritySequence,
	pickOfRarity,
	claimTutorialReward,
} from "./tutorialRewardModel";

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

describe("TUTORIAL_REWARD_RARITY_COUNTS", () => {
	it("is the fixed 10/6/3/1 composition", () => {
		expect(TUTORIAL_REWARD_RARITY_COUNTS).toEqual({ Commune: 10, Rare: 6, "Épique": 3, "Légendaire": 1 });
		expect(TUTORIAL_REWARD_CARDS).toBe(20);
	});
});

describe("rewardRaritySequence", () => {
	it("lists one entry per card, commons first and the legendary last", () => {
		const sequence = rewardRaritySequence();
		expect(sequence).toHaveLength(TUTORIAL_REWARD_CARDS);
		expect(sequence.filter((r) => r === "Commune")).toHaveLength(10);
		expect(sequence.filter((r) => r === "Rare")).toHaveLength(6);
		expect(sequence.filter((r) => r === "Épique")).toHaveLength(3);
		expect(sequence[0]).toBe("Commune");
		expect(sequence[sequence.length - 1]).toBe("Légendaire");
	});
});

describe("pickOfRarity", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("picks a card of the requested rarity", () => {
		expect(pickOfRarity(poolByRarity() as never, "Épique").rarity).toBe("Épique");
		expect(pickOfRarity(poolByRarity() as never, "Légendaire").rarity).toBe("Légendaire");
	});

	it("falls back to another rarity when the catalogue holds none of it", () => {
		const pool = poolByRarity();
		pool.set("Légendaire", []);
		expect(pickOfRarity(pool as never, "Légendaire").rarity).not.toBe("Légendaire");
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
		// poussière — les deux chemins réunis couvrent toujours les 20 tirages.
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
