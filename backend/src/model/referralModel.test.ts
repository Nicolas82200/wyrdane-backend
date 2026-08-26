import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));
vi.mock("./currencyModel", () => ({
	credit: vi.fn(),
	creditFreePacks: vi.fn(),
}));

import db from "./db";
import { credit, creditFreePacks } from "./currencyModel";
import {
	REFERRAL_REWARD_GOLD,
	REFERRAL_REWARD_PACKS,
	ReferralInvalidCodeError,
	ReferralSelfError,
	ReferralAlreadyReferredError,
	ReferralCodeUsedError,
	getOrCreateCode,
	getStatus,
	redeemCode,
	completeReferralIfPending,
} from "./referralModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedCredit = credit as ReturnType<typeof vi.fn>;
const mockedCreditFreePacks = creditFreePacks as ReturnType<typeof vi.fn>;

const referralRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 1,
	referrer_id: 1,
	code: "ABCD1234",
	referred_id: null,
	redeemed_at: null,
	completed_at: null,
	reward_granted_at: null,
	...overrides,
});

describe("getOrCreateCode", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the existing code without inserting when one already exists", async () => {
		mockedDb.query.mockResolvedValueOnce([[referralRow({ code: "EXISTING" })]]);

		const code = await getOrCreateCode(1);

		expect(code).toBe("EXISTING");
		expect(mockedDb.query).toHaveBeenCalledTimes(1);
	});

	it("generates and inserts a new code when none exists yet", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);
		mockedDb.query.mockResolvedValueOnce([{}]); // INSERT succeeds

		const code = await getOrCreateCode(1);

		expect(code).toHaveLength(8);
		expect(mockedDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining("INSERT INTO referrals"), [1, code]);
	});

	it("re-reads the row on a duplicate-key race instead of failing", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]); // no existing row
		const dupError = Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
		mockedDb.query.mockRejectedValueOnce(dupError); // INSERT collides
		mockedDb.query.mockResolvedValueOnce([[referralRow({ code: "RACEWON" })]]); // re-read

		const code = await getOrCreateCode(1);

		expect(code).toBe("RACEWON");
	});
});

describe("getStatus", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns status 'none' when no one has redeemed the code yet", async () => {
		mockedDb.query.mockResolvedValueOnce([[referralRow({ code: "MYCODE" })]]); // getOrCreateCode
		mockedDb.query.mockResolvedValueOnce([[referralRow({ code: "MYCODE", referred_id: null, referred_username: null })]]);

		const status = await getStatus(1);

		expect(status).toEqual({ code: "MYCODE", referred_username: null, status: "none", reward_granted: false });
	});

	it("returns status 'pending' when redeemed but the referred player hasn't finished the tutorial", async () => {
		mockedDb.query.mockResolvedValueOnce([[referralRow({ code: "MYCODE" })]]);
		mockedDb.query.mockResolvedValueOnce([
			[referralRow({ code: "MYCODE", referred_id: 2, completed_at: null, referred_username: "Friend" })],
		]);

		const status = await getStatus(1);

		expect(status).toEqual({ code: "MYCODE", referred_username: "Friend", status: "pending", reward_granted: false });
	});

	it("returns status 'completed' with reward_granted once the reward has been paid out", async () => {
		mockedDb.query.mockResolvedValueOnce([[referralRow({ code: "MYCODE" })]]);
		mockedDb.query.mockResolvedValueOnce([
			[
				referralRow({
					code: "MYCODE",
					referred_id: 2,
					completed_at: "2026-08-24T00:00:00Z",
					reward_granted_at: "2026-08-24T00:00:00Z",
					referred_username: "Friend",
				}),
			],
		]);

		const status = await getStatus(1);

		expect(status).toEqual({ code: "MYCODE", referred_username: "Friend", status: "completed", reward_granted: true });
	});
});

describe("redeemCode", () => {
	beforeEach(() => vi.clearAllMocks());

	const makeConnection = (calls: unknown[][]) => {
		const query = vi.fn();
		for (const result of calls) query.mockResolvedValueOnce([result]);
		query.mockResolvedValue([{}]);
		return { query, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
	};

	it("throws ReferralInvalidCodeError when the code doesn't exist", async () => {
		const connection = makeConnection([[]]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(redeemCode(2, "NOPE0000")).rejects.toThrow(ReferralInvalidCodeError);
		expect(connection.rollback).toHaveBeenCalledTimes(1);
	});

	it("throws ReferralSelfError when the code belongs to the redeeming player", async () => {
		const connection = makeConnection([[referralRow({ referrer_id: 2 })]]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(redeemCode(2, "ABCD1234")).rejects.toThrow(ReferralSelfError);
	});

	it("throws ReferralCodeUsedError when the referrer's single slot is already taken", async () => {
		const connection = makeConnection([[referralRow({ referred_id: 99 })]]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(redeemCode(2, "ABCD1234")).rejects.toThrow(ReferralCodeUsedError);
	});

	it("throws ReferralAlreadyReferredError when this player was already referred by someone else", async () => {
		const connection = makeConnection([[referralRow()], [referralRow({ id: 5, referrer_id: 9, referred_id: 2 })]]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await expect(redeemCode(2, "ABCD1234")).rejects.toThrow(ReferralAlreadyReferredError);
	});

	it("links the referred player without granting the reward yet when the tutorial isn't finished", async () => {
		const connection = makeConnection([
			[referralRow()], // referrer row
			[], // no existing referral for this referred player
			[{}], // UPDATE referred_id (result unused)
			[{ starter_claimed_at: null }], // tutorial not finished
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await redeemCode(2, "ABCD1234");

		expect(connection.query).toHaveBeenCalledWith(
			expect.stringContaining("SET referred_id = ?, redeemed_at = NOW()"),
			[2, 1],
		);
		expect(mockedCredit).not.toHaveBeenCalled();
		expect(connection.commit).toHaveBeenCalledTimes(1);
	});

	it("grants the reward immediately when the referred player already finished the tutorial", async () => {
		const connection = makeConnection([
			[referralRow()],
			[],
			[{}], // UPDATE referred_id (result unused)
			[{ starter_claimed_at: "2026-08-20T00:00:00Z" }],
		]);
		mockedDb.getConnection.mockResolvedValueOnce(connection);

		await redeemCode(2, "ABCD1234");

		expect(mockedCredit).toHaveBeenCalledWith(1, REFERRAL_REWARD_GOLD, "referral_reward", "1", connection);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, REFERRAL_REWARD_PACKS, connection);
		expect(connection.commit).toHaveBeenCalledTimes(1);
	});
});

describe("completeReferralIfPending", () => {
	beforeEach(() => vi.clearAllMocks());

	it("is a no-op when this player was never referred", async () => {
		const connection = { query: vi.fn().mockResolvedValueOnce([[]]) };

		await completeReferralIfPending(2, connection as never);

		expect(mockedCredit).not.toHaveBeenCalled();
	});

	it("completes the referral and credits the referrer when pending", async () => {
		const connection = {
			query: vi.fn().mockResolvedValueOnce([[referralRow({ referred_id: 2 })]]).mockResolvedValue([{}]),
		};

		await completeReferralIfPending(2, connection as never);

		expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), [2]);
		expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("completed_at = NOW()"), [1]);
		expect(mockedCredit).toHaveBeenCalledWith(1, REFERRAL_REWARD_GOLD, "referral_reward", "1", connection);
		expect(mockedCreditFreePacks).toHaveBeenCalledWith(1, REFERRAL_REWARD_PACKS, connection);
	});
});
