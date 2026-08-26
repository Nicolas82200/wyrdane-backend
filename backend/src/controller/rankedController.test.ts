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
vi.mock("../model/questModel", () => ({
	progressForMatch: vi.fn(),
}));
vi.mock("../model/currencyModel", () => ({
	getBalance: vi.fn(),
	getCreditedAmountForReference: vi.fn(),
}));

import {
	getStats,
	findMatchHistory,
	findReport,
	createReport,
	confirmMatch,
	getLeaderboard,
} from "../model/rankedModel";
import { progressForMatch } from "../model/questModel";
import { getBalance, getCreditedAmountForReference } from "../model/currencyModel";
import { reportMatch, getMyStats, getLeaderboardHandler } from "./rankedController";

const mocked = {
	getStats: getStats as ReturnType<typeof vi.fn>,
	findMatchHistory: findMatchHistory as ReturnType<typeof vi.fn>,
	findReport: findReport as ReturnType<typeof vi.fn>,
	createReport: createReport as ReturnType<typeof vi.fn>,
	confirmMatch: confirmMatch as ReturnType<typeof vi.fn>,
	getLeaderboard: getLeaderboard as ReturnType<typeof vi.fn>,
	progressForMatch: progressForMatch as ReturnType<typeof vi.fn>,
	getBalance: getBalance as ReturnType<typeof vi.fn>,
	getCreditedAmountForReference: getCreditedAmountForReference as ReturnType<typeof vi.fn>,
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

	it("short-circuits to confirmed if the match was already settled (idempotent retry), returning the caller's actual credited amount", async () => {
		mocked.findMatchHistory.mockResolvedValue({ id: 1, winner_id: 1 });
		mocked.getCreditedAmountForReference.mockResolvedValue(15);
		mocked.getBalance.mockResolvedValue(1100);
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.getCreditedAmountForReference).toHaveBeenCalledWith(1, "m1");
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({ status: "confirmed", reward: 15, balance: 1100 }),
		);
		expect(mocked.createReport).not.toHaveBeenCalled();
	});

	it("returns whatever the losing side was actually credited on idempotent retry (defeat still rewards a flat amount)", async () => {
		mocked.findMatchHistory.mockResolvedValue({ id: 1, winner_id: 2 });
		mocked.getCreditedAmountForReference.mockResolvedValue(5);
		mocked.getBalance.mockResolvedValue(1000);
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 2 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed", reward: 5 }));
	});

	it("returns pending (not an error) on a retried report while the peer hasn't reported yet", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport.mockResolvedValue({ id: 5, reporter_id: 1 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(202);
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

		expect(mocked.createReport).toHaveBeenCalledWith("m1", 1, 2, 1, null, null);
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

	it("confirms the match once both reports agree, crediting/returning the winner's reward", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ opponent_id: 1, winner_id: 1 });
		mocked.confirmMatch.mockResolvedValue({ reward: 100 });
		mocked.getBalance.mockResolvedValue(1100);
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.confirmMatch).toHaveBeenCalledWith("m1", 1, 2, 1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({ status: "confirmed", reward: 100, balance: 1100 }),
		);
	});

	it("progresses quests for both players once confirmed, with the correct win/loss flag each", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ opponent_id: 1, winner_id: 1 });
		mocked.confirmMatch.mockResolvedValue({ reward: 100 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.progressForMatch).toHaveBeenCalledWith(1, "ranked", true, {
			cardsPlayedByRace: undefined,
			deckRaces: undefined,
		});
		expect(mocked.progressForMatch).toHaveBeenCalledWith(2, "ranked", false, {
			cardsPlayedByRace: undefined,
			deckRaces: undefined,
		});
	});

	it("progresses quests for both players using each player's own declared race data", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport.mockResolvedValueOnce(null).mockResolvedValueOnce({
			opponent_id: 1,
			winner_id: 1,
			cards_played_by_race: { Demon: 3 },
			deck_races: ["Demon"],
		});
		mocked.confirmMatch.mockResolvedValue({ reward: 100 });
		const req = reqAs(1, {
			clientMatchId: "m1",
			opponentId: 2,
			winnerId: 1,
			cardsPlayedByRace: { Undead: 4 },
			deckRaces: ["Undead"],
		});
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.progressForMatch).toHaveBeenCalledWith(1, "ranked", true, {
			cardsPlayedByRace: { Undead: 4 },
			deckRaces: ["Undead"],
		});
		expect(mocked.progressForMatch).toHaveBeenCalledWith(2, "ranked", false, {
			cardsPlayedByRace: { Demon: 3 },
			deckRaces: ["Demon"],
		});
	});

	it("does not progress quests when the match is only pending (one report)", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.progressForMatch).not.toHaveBeenCalled();
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
