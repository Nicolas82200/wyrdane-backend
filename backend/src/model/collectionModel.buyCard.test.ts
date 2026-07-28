import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("./cardsModel", () => ({
	findById: vi.fn(),
}));
vi.mock("./currencyModel", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./currencyModel")>();
	return { ...actual, debit: vi.fn(), getBalance: vi.fn() };
});

import db from "./db";
import { findById as findCardById } from "./cardsModel";
import { debit, getBalance, InsufficientFundsError } from "./currencyModel";
import { buyCard, getOwnedQuantity, CardNotPurchasableError, MAX_COPIES_PER_CARD } from "./collectionModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedFindCardById = findCardById as ReturnType<typeof vi.fn>;
const mockedDebit = debit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;

const commonCard = { id: 10, name: "Zombie Errant", rarity: "Commune", card_type: "Serviteur" };

const freshConnection = () => ({
	query: vi.fn().mockResolvedValue([{}]),
	beginTransaction: vi.fn(),
	commit: vi.fn(),
	rollback: vi.fn(),
	release: vi.fn(),
});

describe("buyCard", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects with CardNotPurchasableError when the card doesn't exist", async () => {
		mockedFindCardById.mockResolvedValue(null);
		await expect(buyCard(1, 999)).rejects.toThrow(CardNotPurchasableError);
	});

	it("rejects resource cards, which are not real collection rewards", async () => {
		mockedFindCardById.mockResolvedValue({ ...commonCard, card_type: "Ressource" });
		await expect(buyCard(1, 10)).rejects.toThrow(CardNotPurchasableError);
	});

	it("rejects a card whose rarity has no configured price", async () => {
		mockedFindCardById.mockResolvedValue({ ...commonCard, rarity: "Mythique" });
		await expect(buyCard(1, 10)).rejects.toThrow(CardNotPurchasableError);
	});

	it("rejects once the player already owns MAX_COPIES_PER_CARD copies", async () => {
		mockedFindCardById.mockResolvedValue(commonCard);
		mockedDb.query.mockResolvedValueOnce([[{ quantity: MAX_COPIES_PER_CARD }]]);

		await expect(buyCard(1, 10)).rejects.toThrow(CardNotPurchasableError);
	});

	it("propagates InsufficientFundsError and rolls back without granting the card", async () => {
		mockedFindCardById.mockResolvedValue(commonCard);
		mockedDb.query.mockResolvedValueOnce([[{ quantity: 0 }]]);
		const connection = freshConnection();
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedDebit.mockRejectedValueOnce(new InsufficientFundsError());

		await expect(buyCard(1, 10)).rejects.toThrow(InsufficientFundsError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
		expect(connection.commit).not.toHaveBeenCalled();
	});

	it("debits the price, grants one copy and commits on a successful purchase", async () => {
		mockedFindCardById.mockResolvedValue(commonCard);
		mockedDb.query
			.mockResolvedValueOnce([[{ quantity: 1 }]]) // getOwnedQuantity before purchase
			.mockResolvedValueOnce([[{ quantity: 2 }]]); // getOwnedQuantity after purchase (grantCard runs on the transaction connection, not db)
		const connection = freshConnection();
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedDebit.mockResolvedValueOnce(undefined);
		mockedGetBalance.mockResolvedValueOnce(400);

		const result = await buyCard(1, 10);

		expect(mockedDebit).toHaveBeenCalledWith(1, 100, "card_buy", "10", connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ balance: 400, quantity: 2 });
	});
});

describe("getOwnedQuantity", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns 0 when the player owns no copies", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);
		expect(await getOwnedQuantity(1, 10)).toBe(0);
	});
});
