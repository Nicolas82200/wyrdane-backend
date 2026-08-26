import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

import db from "./db";
import {
	InsufficientFundsError,
	InsufficientFreePacksError,
	STARTER_CURRENCY,
	FIRST_LOGIN_REWARD,
	getBalance,
	credit,
	debit,
	getFreePacks,
	creditFreePacks,
	debitFreePack,
	getCreditedAmountForReference,
	countReasonToday,
	claimStarterBonus,
	claimFirstLoginReward,
} from "./currencyModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };

describe("getBalance", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns 0 when the user row is missing", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);
		expect(await getBalance(999)).toBe(0);
	});

	it("returns the stored balance", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ soft_currency: 250 }]]);
		expect(await getBalance(1)).toBe(250);
	});
});

describe("credit", () => {
	beforeEach(() => vi.clearAllMocks());

	it("increments the balance and logs a positive ledger entry", async () => {
		mockedDb.query.mockResolvedValue([{}]);

		await credit(1, 100, "pack_open", "ref-1");

		expect(mockedDb.query).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("soft_currency = soft_currency + ?"),
			[100, 1],
		);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("INSERT INTO currency_ledger"),
			[1, 100, "pack_open", "ref-1"],
		);
	});
});

describe("debit", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws InsufficientFundsError and never mutates the balance when funds are too low", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ soft_currency: 50 }]]);

		await expect(debit(1, 100, "card_buy")).rejects.toThrow(InsufficientFundsError);
		// only the balance SELECT should have run — no UPDATE/INSERT after it
		expect(mockedDb.query).toHaveBeenCalledTimes(1);
	});

	it("debits the balance and logs a negative ledger entry when funds are sufficient", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ soft_currency: 500 }]]).mockResolvedValue([{}]);

		await debit(1, 100, "card_buy", "card-7");

		expect(mockedDb.query).toHaveBeenCalledTimes(3);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("soft_currency = soft_currency - ?"),
			[100, 1],
		);
		expect(mockedDb.query).toHaveBeenNthCalledWith(
			3,
			expect.stringContaining("INSERT INTO currency_ledger"),
			[1, -100, "card_buy", "card-7"],
		);
	});

	it("locks the row with FOR UPDATE when run inside a transaction", async () => {
		const connection = { query: vi.fn().mockResolvedValueOnce([[{ soft_currency: 500 }]]).mockResolvedValue([{}]) };

		await debit(1, 100, "card_buy", undefined, connection as never);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1]);
		expect(mockedDb.query).not.toHaveBeenCalled();
	});
});

describe("getFreePacks", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns 0 when the user row is missing", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);
		expect(await getFreePacks(999)).toBe(0);
	});

	it("returns the stored free_packs count", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ free_packs: 2 }]]);
		expect(await getFreePacks(1)).toBe(2);
	});
});

describe("creditFreePacks", () => {
	beforeEach(() => vi.clearAllMocks());

	it("increments free_packs by the given amount", async () => {
		mockedDb.query.mockResolvedValue([{}]);

		await creditFreePacks(1, 3);

		expect(mockedDb.query).toHaveBeenCalledWith(
			expect.stringContaining("free_packs = free_packs + ?"),
			[3, 1],
		);
	});
});

describe("debitFreePack", () => {
	beforeEach(() => vi.clearAllMocks());

	it("throws InsufficientFreePacksError and never mutates the balance when there is none left", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ free_packs: 0 }]]);

		await expect(debitFreePack(1)).rejects.toThrow(InsufficientFreePacksError);
		expect(mockedDb.query).toHaveBeenCalledTimes(1);
	});

	it("decrements free_packs by 1 when at least one is available", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ free_packs: 2 }]]).mockResolvedValue([{}]);

		await debitFreePack(1);

		expect(mockedDb.query).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("free_packs = free_packs - 1"),
			[1],
		);
	});

	it("locks the row with FOR UPDATE when run inside a transaction", async () => {
		const connection = { query: vi.fn().mockResolvedValueOnce([[{ free_packs: 1 }]]).mockResolvedValue([{}]) };

		await debitFreePack(1, connection as never);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1]);
		expect(mockedDb.query).not.toHaveBeenCalled();
	});
});

describe("getCreditedAmountForReference", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns 0 when no ledger entry matches", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ amount: 0 }]]);
		expect(await getCreditedAmountForReference(1, "match-1")).toBe(0);
	});

	it("returns the summed ledger amount for that user and reference", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ amount: 15 }]]);
		expect(await getCreditedAmountForReference(1, "match-1")).toBe(15);
		expect(mockedDb.query).toHaveBeenCalledWith(expect.stringContaining("SUM(amount)"), [1, "match-1"]);
	});
});

describe("countReasonToday", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the count of matching ledger rows today", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ count: 3 }]]);
		expect(await countReasonToday(1, "match_win_solo")).toBe(3);
	});
});

describe("claimStarterBonus", () => {
	beforeEach(() => vi.clearAllMocks());

	it("is a no-op when the bonus was already claimed", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ starter_currency_claimed_at: "2026-01-01" }]]);
		mockedDb.query.mockResolvedValueOnce([[{ soft_currency: 1000 }]]);

		const result = await claimStarterBonus(1);

		expect(result).toEqual({ credited: false, balance: 1000 });
		expect(mockedDb.getConnection).not.toHaveBeenCalled();
	});

	it("credits STARTER_CURRENCY and marks it claimed, in a committed transaction", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ starter_currency_claimed_at: null }]]);
		const connection = {
			query: vi.fn().mockResolvedValue([{}]),
			beginTransaction: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			release: vi.fn(),
		};
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedDb.query.mockResolvedValueOnce([[{ soft_currency: STARTER_CURRENCY }]]);

		const result = await claimStarterBonus(1);

		expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
		expect(connection.query).toHaveBeenCalledWith(
			expect.stringContaining("soft_currency = soft_currency + ?"),
			[STARTER_CURRENCY, 1],
		);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(connection.rollback).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ credited: true, balance: STARTER_CURRENCY });
	});

	it("rolls back and rethrows if crediting fails mid-transaction", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ starter_currency_claimed_at: null }]]);
		const connection = {
			query: vi.fn().mockRejectedValue(new Error("db exploded")),
			beginTransaction: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			release: vi.fn(),
		};
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimStarterBonus(1)).rejects.toThrow("db exploded");

		expect(connection.rollback).toHaveBeenCalledTimes(1);
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledTimes(1);
	});
});

describe("claimFirstLoginReward", () => {
	beforeEach(() => vi.clearAllMocks());

	it("is a no-op when the hidden quest was already claimed", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ first_login_reward_claimed_at: "2026-01-01" }]]);
		mockedDb.query.mockResolvedValueOnce([[{ soft_currency: 1500 }]]);

		const result = await claimFirstLoginReward(1);

		expect(result).toEqual({ credited: false, balance: 1500, amount: FIRST_LOGIN_REWARD });
		expect(mockedDb.getConnection).not.toHaveBeenCalled();
	});

	it("credits FIRST_LOGIN_REWARD and marks it claimed, in a committed transaction", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ first_login_reward_claimed_at: null }]]);
		const connection = {
			query: vi.fn().mockResolvedValue([{}]),
			beginTransaction: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			release: vi.fn(),
		};
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedDb.query.mockResolvedValueOnce([[{ soft_currency: FIRST_LOGIN_REWARD }]]);

		const result = await claimFirstLoginReward(1);

		expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
		expect(connection.query).toHaveBeenCalledWith(
			expect.stringContaining("soft_currency = soft_currency + ?"),
			[FIRST_LOGIN_REWARD, 1],
		);
		expect(connection.query).toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO currency_ledger"),
			[1, FIRST_LOGIN_REWARD, "first_login_reward", null],
		);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(connection.rollback).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ credited: true, balance: FIRST_LOGIN_REWARD, amount: FIRST_LOGIN_REWARD });
	});

	it("rolls back and rethrows if crediting fails mid-transaction", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ first_login_reward_claimed_at: null }]]);
		const connection = {
			query: vi.fn().mockRejectedValue(new Error("db exploded")),
			beginTransaction: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			release: vi.fn(),
		};
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claimFirstLoginReward(1)).rejects.toThrow("db exploded");

		expect(connection.rollback).toHaveBeenCalledTimes(1);
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledTimes(1);
	});
});
