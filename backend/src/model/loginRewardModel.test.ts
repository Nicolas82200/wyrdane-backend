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

import db from "./db";
import { credit, getBalance } from "./currencyModel";
import { AlreadyClaimedTodayError, REWARD_BY_DAY, rewardForDay, getStatus, claim } from "./loginRewardModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
	user_id: 1,
	streak_day: 0,
	last_claimed_date: null,
	claimed_today: 0,
	is_consecutive: 0,
	...overrides,
});

describe("rewardForDay", () => {
	it("returns the matching reward for days 1-7", () => {
		REWARD_BY_DAY.forEach((reward, index) => {
			expect(rewardForDay(index + 1)).toBe(reward);
		});
	});

	it("cycles back to day 1's reward on day 8", () => {
		expect(rewardForDay(8)).toBe(REWARD_BY_DAY[0]);
	});
});

describe("getStatus", () => {
	beforeEach(() => vi.clearAllMocks());

	it("reports day 1, unclaimed, for a brand new player", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[row()]]);

		const status = await getStatus(1);

		expect(status).toEqual({ claimed_today: false, streak_day: 1 });
	});

	it("reports the stored streak as claimed when already claimed today", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[row({ streak_day: 3, claimed_today: 1 })]]);

		const status = await getStatus(1);

		expect(status).toEqual({ claimed_today: true, streak_day: 3 });
	});

	it("bumps the streak by one when the last claim was yesterday", async () => {
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[row({ streak_day: 3, claimed_today: 0, is_consecutive: 1 })]]);

		const status = await getStatus(1);

		expect(status).toEqual({ claimed_today: false, streak_day: 4 });
	});

	it("resets the streak to 1 when a day was missed", async () => {
		mockedDb.query
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[row({ streak_day: 5, claimed_today: 0, is_consecutive: 0 })]]);

		const status = await getStatus(1);

		expect(status).toEqual({ claimed_today: false, streak_day: 1 });
	});
});

describe("claim", () => {
	beforeEach(() => vi.clearAllMocks());

	const makeConnection = (selectResult: unknown[]) => ({
		query: vi.fn().mockResolvedValueOnce([selectResult]).mockResolvedValue([{}]),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	});

	it("throws AlreadyClaimedTodayError on a second claim the same day", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]); // ensureRow
		const connection = makeConnection([row({ claimed_today: 1 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claim(1)).rejects.toThrow(AlreadyClaimedTodayError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
		expect(mockedCredit).not.toHaveBeenCalled();
	});

	it("grants day 1's reward and starts the streak for a first claim", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]);
		const connection = makeConnection([row()]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1010);

		const result = await claim(1);

		expect(connection.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE"), [1]);
		expect(connection.query).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("SET streak_day = ?, last_claimed_date = CURDATE()"),
			[1, 1],
		);
		expect(mockedCredit).toHaveBeenCalledWith(1, REWARD_BY_DAY[0], "daily_login_reward", undefined, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ streak_day: 1, reward_currency: REWARD_BY_DAY[0], balance: 1010 });
	});

	it("continues the streak and its reward when claimed the day after the last one", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]);
		const connection = makeConnection([row({ streak_day: 2, claimed_today: 0, is_consecutive: 1 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1020);

		const result = await claim(1);

		expect(connection.query).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("SET streak_day = ?, last_claimed_date = CURDATE()"),
			[3, 1],
		);
		expect(mockedCredit).toHaveBeenCalledWith(1, REWARD_BY_DAY[2], "daily_login_reward", undefined, connection);
		expect(result.streak_day).toBe(3);
	});

	it("resets the streak to 1 when a day was missed", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]);
		const connection = makeConnection([row({ streak_day: 6, claimed_today: 0, is_consecutive: 0 })]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);
		mockedGetBalance.mockResolvedValueOnce(1010);

		const result = await claim(1);

		expect(result.streak_day).toBe(1);
		expect(mockedCredit).toHaveBeenCalledWith(1, REWARD_BY_DAY[0], "daily_login_reward", undefined, connection);
	});

	it("rolls back and rethrows if crediting fails mid-transaction", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]);
		const connection = {
			query: vi.fn().mockResolvedValueOnce([[row()]]).mockRejectedValue(new Error("db exploded")),
			beginTransaction: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			release: vi.fn(),
		};
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(claim(1)).rejects.toThrow("db exploded");

		expect(connection.rollback).toHaveBeenCalledTimes(1);
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledTimes(1);
	});
});
