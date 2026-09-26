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
vi.mock("../model/monthlyQuestModel", () => ({
	progressForMatch: vi.fn(),
}));
vi.mock("../model/uniqueQuestModel", () => ({
	progressForMatch: vi.fn(),
}));
vi.mock("../model/onboardingQuestModel", () => ({
	progressForMatch: vi.fn(),
}));
vi.mock("../model/levelModel", () => ({
	getLevel: vi.fn(),
}));

import { credit, getBalance } from "../model/currencyModel";
import { incrementResult } from "../model/soloStatsModel";
import { progressForMatch } from "../model/questModel";
import { progressForMatch as progressWeeklyForMatch } from "../model/weeklyQuestModel";
import { progressForMatch as progressMonthlyForMatch } from "../model/monthlyQuestModel";
import { progressForMatch as progressUniqueForMatch } from "../model/uniqueQuestModel";
import { progressForMatch as progressOnboardingForMatch } from "../model/onboardingQuestModel";
import { getLevel } from "../model/levelModel";
import { reportSoloMatch } from "./rewardsController";

const mocked = {
	credit: credit as ReturnType<typeof vi.fn>,
	getBalance: getBalance as ReturnType<typeof vi.fn>,
	incrementResult: incrementResult as ReturnType<typeof vi.fn>,
	progressForMatch: progressForMatch as ReturnType<typeof vi.fn>,
	progressWeeklyForMatch: progressWeeklyForMatch as ReturnType<typeof vi.fn>,
	progressMonthlyForMatch: progressMonthlyForMatch as ReturnType<typeof vi.fn>,
	progressUniqueForMatch: progressUniqueForMatch as ReturnType<typeof vi.fn>,
	progressOnboardingForMatch: progressOnboardingForMatch as ReturnType<typeof vi.fn>,
	getLevel: getLevel as ReturnType<typeof vi.fn>,
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
		mocked.getLevel.mockResolvedValue({ level: 5, xp: 0, xpToNext: 100 });
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

	it("records the stat and progresses quests for a defeat, without crediting any gold", async () => {
		mocked.incrementResult.mockResolvedValue(0);
		const req = reqAs(1, { result: "defeat" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.incrementResult).toHaveBeenCalledWith(1, false);
		expect(mocked.progressForMatch).toHaveBeenCalledWith(1, "solo", false, {
			cardsPlayedByRace: undefined,
			deckRaces: undefined,
		});
		expect(mocked.credit).not.toHaveBeenCalled();
		expect(mocked.progressOnboardingForMatch).toHaveBeenCalledWith(1, 5, "solo", false);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ credited: false, reward: 0 }));
	});

	it("records the stat and progresses quests for a victory, without crediting any gold", async () => {
		mocked.incrementResult.mockResolvedValue(4);
		const req = reqAs(1, { result: "victory" });
		const res = mockRes();

		await reportSoloMatch(req, res);

		expect(mocked.incrementResult).toHaveBeenCalledWith(1, true);
		expect(mocked.progressForMatch).toHaveBeenCalledWith(1, "solo", true, {
			cardsPlayedByRace: undefined,
			deckRaces: undefined,
		});
		expect(mocked.credit).not.toHaveBeenCalled();
		expect(mocked.progressOnboardingForMatch).toHaveBeenCalledWith(1, 5, "solo", true);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({ credited: false, reward: 0, winStreak: 4, balance: 1000 }),
		);
	});
});
