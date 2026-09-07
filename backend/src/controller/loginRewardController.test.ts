import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/loginRewardModel", async () => {
	const actual = await vi.importActual<typeof import("../model/loginRewardModel")>("../model/loginRewardModel");
	return {
		...actual,
		getStatus: vi.fn(),
		claim: vi.fn(),
	};
});

import { getStatus, claim, AlreadyClaimedTodayError } from "../model/loginRewardModel";
import { getMyLoginRewardStatus, claimMyLoginReward } from "./loginRewardController";

const mocked = {
	getStatus: getStatus as ReturnType<typeof vi.fn>,
	claim: claim as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined): Request => ({ user: userId ? { id: userId } : undefined } as unknown as Request);

describe("getMyLoginRewardStatus", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await getMyLoginRewardStatus(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("returns the caller's status", async () => {
		mocked.getStatus.mockResolvedValue({ claimed_today: false, streak_day: 2 });
		const res = mockRes();
		await getMyLoginRewardStatus(reqAs(1), res);
		expect(mocked.getStatus).toHaveBeenCalledWith(1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ claimed_today: false, streak_day: 2 });
	});
});

describe("claimMyLoginReward", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await claimMyLoginReward(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocked.claim).not.toHaveBeenCalled();
	});

	it("returns 400 when already claimed today", async () => {
		mocked.claim.mockRejectedValue(new AlreadyClaimedTodayError());
		const res = mockRes();
		await claimMyLoginReward(reqAs(1), res);
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("returns the claim result on success", async () => {
		mocked.claim.mockResolvedValue({ streak_day: 3, reward_currency: 20, balance: 1020 });
		const res = mockRes();
		await claimMyLoginReward(reqAs(1), res);
		expect(mocked.claim).toHaveBeenCalledWith(1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ streak_day: 3, reward_currency: 20, balance: 1020 });
	});
});
