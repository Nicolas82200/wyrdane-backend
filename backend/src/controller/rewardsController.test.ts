import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/currencyModel", () => ({
	credit: vi.fn(),
	getBalance: vi.fn(),
}));
vi.mock("../model/soloStatsModel", () => ({
	incrementResult: vi.fn(),
}));
vi.mock("../model/questModel", () => ({
	progressForMatch: vi.fn(),
}));
vi.mock("../model/weeklyQuestModel", () => ({
	progressForMatch: vi.fn(),
}));

import { credit, getBalance } from "../model/currencyModel";
import { incrementResult } from "../model/soloStatsModel";
import { progressForMatch } from "../model/questModel";
import { progressForMatch as progressWeeklyForMatch } from "../model/weeklyQuestModel";
import { reportSoloMatch } from "./rewardsController";

const mocked = {
	credit: credit as ReturnType<typeof vi.fn>,
	getBalance: getBalance as ReturnType<typeof vi.fn>,
	incrementResult: incrementResult as ReturnType<typeof vi.fn>,
	progressForMatch: progressForMatch as ReturnType<typeof vi.fn>,
	progressWeeklyForMatch: progressWeeklyForMatch as ReturnType<typeof vi.fn>,
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

	it("records the stat and progresses quests for a defeat", async () => {
		mocked.incrementResult.mockResolvedValue(0);
		const req = reqAs(1, { result: "defeat" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.incrementResult).toHaveBeenCalledWith(1, false);
		expect(mocked.progressForMatch).toHaveBeenCalledWith(1, "solo", false, {
			cardsPlayedByRace: undefined,
			deckRaces: undefined,
		});
	});

	it("credits a flat reward for a defeat, with no daily cap", async () => {
		mocked.incrementResult.mockResolvedValue(0);
		const req = reqAs(1, { result: "defeat" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).toHaveBeenCalledWith(1, 5, "match_loss_solo");
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ credited: true, reward: 5 }));
	});

	it("credits the base win reward below a 3-win streak", async () => {
		mocked.incrementResult.mockResolvedValue(2);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).toHaveBeenCalledWith(1, 10, "match_win_solo");
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ credited: true, reward: 10, winStreak: 2 }));
	});

	it("credits 15 gold at a 3-win streak", async () => {
		mocked.incrementResult.mockResolvedValue(3);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).toHaveBeenCalledWith(1, 15, "match_win_solo");
	});

	it("credits 20 gold at a 5-win streak", async () => {
		mocked.incrementResult.mockResolvedValue(5);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).toHaveBeenCalledWith(1, 20, "match_win_solo");
	});

	it("credits 25 gold at a 7-win streak and beyond", async () => {
		mocked.incrementResult.mockResolvedValue(9);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.credit).toHaveBeenCalledWith(1, 25, "match_win_solo");
	});
});
