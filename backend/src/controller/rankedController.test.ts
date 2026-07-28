import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/rankedModel", () => ({
	getStats: vi.fn(),
	findMatchHistory: vi.fn(),
	findReport: vi.fn(),
	createReport: vi.fn(),
	confirmMatch: vi.fn(),
	getLeaderboard: vi.fn(),
}));

import {
	getStats,
	findMatchHistory,
	findReport,
	createReport,
	confirmMatch,
	getLeaderboard,
} from "../model/rankedModel";
import { reportMatch, getMyStats, getLeaderboardHandler } from "./rankedController";

const mocked = {
	getStats: getStats as ReturnType<typeof vi.fn>,
	findMatchHistory: findMatchHistory as ReturnType<typeof vi.fn>,
	findReport: findReport as ReturnType<typeof vi.fn>,
	createReport: createReport as ReturnType<typeof vi.fn>,
	confirmMatch: confirmMatch as ReturnType<typeof vi.fn>,
	getLeaderboard: getLeaderboard as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number, body: Record<string, unknown>): Request =>
	({ user: { id: userId }, body } as unknown as Request);

describe("reportMatch", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const req = { user: undefined, body: {} } as unknown as Request;
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocked.createReport).not.toHaveBeenCalled();
	});

	it("rejects a payload where winnerId is neither the reporter nor the opponent", async () => {
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 999 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.createReport).not.toHaveBeenCalled();
	});

	it("rejects a payload missing required fields", async () => {
		const req = reqAs(1, { clientMatchId: "m1" });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("short-circuits to confirmed if the match was already settled (idempotent retry)", async () => {
		mocked.findMatchHistory.mockResolvedValue({ id: 1, winner_id: 1 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed" }));
		expect(mocked.createReport).not.toHaveBeenCalled();
	});

	it("rejects a second report from the same reporter for the same match (409)", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport.mockResolvedValue({ id: 5, reporter_id: 1 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(409);
		expect(mocked.createReport).not.toHaveBeenCalled();
	});

	it("returns pending when this is the first of the two reports", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null) // reporter's own report: none yet
			.mockResolvedValueOnce(null); // opponent hasn't reported yet
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.createReport).toHaveBeenCalledWith("m1", 1, 2, 1);
		expect(res.status).toHaveBeenCalledWith(202);
		expect(mocked.confirmMatch).not.toHaveBeenCalled();
	});

	it("flags a conflict when the two reports disagree on the winner (anti-cheat)", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null) // reporter's own report: none yet
			.mockResolvedValueOnce({ opponent_id: 1, winner_id: 2 }); // opponent claims THEY won
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(409);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "conflict" }));
		expect(mocked.confirmMatch).not.toHaveBeenCalled();
	});

	it("flags a conflict when the opponent's report doesn't name this reporter as the opponent", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ opponent_id: 999, winner_id: 1 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(409);
		expect(mocked.confirmMatch).not.toHaveBeenCalled();
	});

	it("confirms the match once both reports agree", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ opponent_id: 1, winner_id: 1 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.confirmMatch).toHaveBeenCalledWith("m1", 1, 2, 1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed" }));
	});
});

describe("getMyStats", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const req = { user: undefined } as unknown as Request;
		const res = mockRes();
		await getMyStats(req, res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("returns the caller's stats", async () => {
		mocked.getStats.mockResolvedValue({ user_id: 1, mmr: 1000, wins: 2, losses: 1 });
		const req = reqAs(1, {});
		const res = mockRes();
		await getMyStats(req, res);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("getLeaderboardHandler", () => {
	beforeEach(() => vi.resetAllMocks());

	it("caps the requested page size at 100", async () => {
		mocked.getLeaderboard.mockResolvedValue([]);
		const req = { query: { limit: "9999", offset: "0" } } as unknown as Request;
		const res = mockRes();

		await getLeaderboardHandler(req, res);

		expect(mocked.getLeaderboard).toHaveBeenCalledWith(100, 0);
	});

	it("falls back to sane defaults for missing/invalid query params", async () => {
		mocked.getLeaderboard.mockResolvedValue([]);
		const req = { query: {} } as unknown as Request;
		const res = mockRes();

		await getLeaderboardHandler(req, res);

		expect(mocked.getLeaderboard).toHaveBeenCalledWith(50, 0);
	});
});
