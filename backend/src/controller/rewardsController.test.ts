import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/currencyModel", () => ({
	credit: vi.fn(),
	getBalance: vi.fn(),
	countReasonToday: vi.fn(),
}));
vi.mock("../model/soloStatsModel", () => ({
	incrementResult: vi.fn(),
}));

import { credit, getBalance, countReasonToday } from "../model/currencyModel";
import { incrementResult } from "../model/soloStatsModel";
import { reportSoloMatch } from "./rewardsController";

const mocked = {
	credit: credit as ReturnType<typeof vi.fn>,
	getBalance: getBalance as ReturnType<typeof vi.fn>,
	countReasonToday: countReasonToday as ReturnType<typeof vi.fn>,
	incrementResult: incrementResult as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, body: Record<string, unknown>): Request =>
	({ user: userId ? { id: userId } : undefined, body } as unknown as Request);

describe("reportSoloMatch", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocked.getBalance.mockResolvedValue(1000);
	});

	it("rejects unauthenticated requests", async () => {
		const req = reqAs(undefined, { result: "victory" });
		const res = mockRes();
		await reportSoloMatch(req, res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects a payload with an invalid result value", async () => {
		const req = reqAs(1, { result: "draw" });
		const res = mockRes();
		await reportSoloMatch(req, res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.credit).not.toHaveBeenCalled();
	});

	it("always records the stat, even when the daily cap is reached", async () => {
		mocked.countReasonToday.mockResolvedValue(5);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.incrementResult).toHaveBeenCalledWith(1, true);
	});

	it("does not credit currency once the daily win cap is reached", async () => {
		mocked.countReasonToday.mockResolvedValue(5);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ credited: false }));
	});

	it("credits the win reward while under the daily cap", async () => {
		mocked.countReasonToday.mockResolvedValue(2);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).toHaveBeenCalledWith(1, 25, "match_win_solo");
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ credited: true }));
	});

	it("credits a smaller reward for a defeat, tracked under a separate daily cap", async () => {
		mocked.countReasonToday.mockResolvedValue(0);
		const req = reqAs(1, { result: "defeat" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.countReasonToday).toHaveBeenCalledWith(1, "match_loss_solo");
		expect(mocked.credit).toHaveBeenCalledWith(1, 10, "match_loss_solo");
	});

	it("keeps win and defeat daily caps independent of each other", async () => {
		// 5 defeats already logged today must not block a victory reward
		mocked.countReasonToday.mockImplementation((_userId: number, reason: string) =>
			Promise.resolve(reason === "match_loss_solo" ? 5 : 0),
		);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).toHaveBeenCalledWith(1, 25, "match_win_solo");
	});
});
