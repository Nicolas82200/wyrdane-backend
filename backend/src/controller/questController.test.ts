import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/questModel", async () => {
	const actual = await vi.importActual<typeof import("../model/questModel")>("../model/questModel");
	return {
		...actual,
		getDailyQuests: vi.fn(),
		claimQuest: vi.fn(),
	};
});

import { getDailyQuests, claimQuest, QuestNotFoundError, QuestNotCompletedError, QuestAlreadyClaimedError } from "../model/questModel";
import { getMyDailyQuests, claimMyQuest } from "./questController";

const mocked = {
	getDailyQuests: getDailyQuests as ReturnType<typeof vi.fn>,
	claimQuest: claimQuest as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, params: Record<string, string> = {}): Request =>
	({ user: userId ? { id: userId } : undefined, params } as unknown as Request);

describe("getMyDailyQuests", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await getMyDailyQuests(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("returns the caller's daily quests", async () => {
		mocked.getDailyQuests.mockResolvedValue({ quests: [], resets_at: "2026-08-18T00:00:00Z" });
		const res = mockRes();
		await getMyDailyQuests(reqAs(1), res);
		expect(mocked.getDailyQuests).toHaveBeenCalledWith(1);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("claimMyQuest", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await claimMyQuest(reqAs(undefined, { id: "1" }), res);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocked.claimQuest).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric quest id", async () => {
		const res = mockRes();
		await claimMyQuest(reqAs(1, { id: "abc" }), res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.claimQuest).not.toHaveBeenCalled();
	});

	it("returns 404 when the quest doesn't belong to the caller", async () => {
		mocked.claimQuest.mockRejectedValue(new QuestNotFoundError());
		const res = mockRes();
		await claimMyQuest(reqAs(1, { id: "999" }), res);
		expect(res.status).toHaveBeenCalledWith(404);
	});

	it("returns 400 when the quest isn't completed yet", async () => {
		mocked.claimQuest.mockRejectedValue(new QuestNotCompletedError());
		const res = mockRes();
		await claimMyQuest(reqAs(1, { id: "1" }), res);
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("returns 400 when the quest was already claimed", async () => {
		mocked.claimQuest.mockRejectedValue(new QuestAlreadyClaimedError());
		const res = mockRes();
		await claimMyQuest(reqAs(1, { id: "1" }), res);
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("credits the reward and returns the new balance on success", async () => {
		mocked.claimQuest.mockResolvedValue({ balance: 1050, reward_currency: 50 });
		const res = mockRes();
		await claimMyQuest(reqAs(1, { id: "1" }), res);
		expect(mocked.claimQuest).toHaveBeenCalledWith(1, 1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ balance: 1050, reward_currency: 50 });
	});
});
