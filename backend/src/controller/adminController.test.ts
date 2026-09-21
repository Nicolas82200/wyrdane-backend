import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/analyticsModel", () => ({
	getStats: vi.fn(),
	setWishlistCount: vi.fn(),
}));
vi.mock("../model/rankedModel", () => ({
	getCardStats: vi.fn(),
}));

import { getCardStats } from "../model/rankedModel";
import { getAdminCardStats } from "./adminController";

const mocked = {
	getCardStats: getCardStats as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

describe("getAdminCardStats", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns play_rate and winrate derived from raw counts, no minimum-matches threshold", async () => {
		mocked.getCardStats.mockResolvedValue({
			totalRankedMatches: 100,
			cards: [
				{ card_name: "Zombie affamé", matches_played: 40, instances: 45, wins: 27 },
				{ card_name: "Carte rare", matches_played: 2, instances: 2, wins: 1 },
			],
		});
		const res = mockRes();

		await getAdminCardStats({} as Request, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			total_ranked_matches: 100,
			cards: [
				{ card_name: "Zombie affamé", play_rate: 0.4, matches_played: 40, winrate: 0.6 },
				{ card_name: "Carte rare", play_rate: 0.02, matches_played: 2, winrate: 0.5 },
			],
		});
	});

	it("returns 500 on model error", async () => {
		mocked.getCardStats.mockRejectedValue(new Error("db down"));
		const res = mockRes();

		await getAdminCardStats({} as Request, res);

		expect(res.status).toHaveBeenCalledWith(500);
	});
});
