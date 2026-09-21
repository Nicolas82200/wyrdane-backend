import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/rankedModel", () => ({
	getStats: vi.fn(),
	findMatchHistory: vi.fn(),
	findReport: vi.fn(),
	createReport: vi.fn(),
	confirmMatch: vi.fn(),
	getLeaderboard: vi.fn(),
	getMyLeaderboardPosition: vi.fn(),
	searchLeaderboard: vi.fn(),
	recordCardPlays: vi.fn(),
}));
vi.mock("../model/questModel", () => ({
	progressForMatch: vi.fn(),
}));
vi.mock("../model/weeklyQuestModel", () => ({
	progressForMatch: vi.fn(),
}));
vi.mock("../model/uniqueQuestModel", () => ({
	progressForMatch: vi.fn(),
	progressForRankTier: vi.fn(),
}));
vi.mock("../model/levelModel", () => ({
	getLevel: vi.fn(),
}));

import {
	getStats,
	findMatchHistory,
	findReport,
	createReport,
	confirmMatch,
	getLeaderboard,
	getMyLeaderboardPosition,
	searchLeaderboard,
	recordCardPlays,
} from "../model/rankedModel";
import { progressForMatch } from "../model/questModel";
import { progressForMatch as progressWeeklyForMatch } from "../model/weeklyQuestModel";
import { progressForMatch as progressUniqueForMatch, progressForRankTier } from "../model/uniqueQuestModel";
import { getLevel } from "../model/levelModel";
import { issueMatchSessionToken } from "../helper/matchSessionToken";
import {
	reportMatch,
	getMyStats,
	getLeaderboardHandler,
	getMyLeaderboardPositionHandler,
	searchLeaderboardHandler,
} from "./rankedController";

const mocked = {
	getStats: getStats as ReturnType<typeof vi.fn>,
	findMatchHistory: findMatchHistory as ReturnType<typeof vi.fn>,
	findReport: findReport as ReturnType<typeof vi.fn>,
	createReport: createReport as ReturnType<typeof vi.fn>,
	confirmMatch: confirmMatch as ReturnType<typeof vi.fn>,
	getLeaderboard: getLeaderboard as ReturnType<typeof vi.fn>,
	getMyLeaderboardPosition: getMyLeaderboardPosition as ReturnType<typeof vi.fn>,
	searchLeaderboard: searchLeaderboard as ReturnType<typeof vi.fn>,
	recordCardPlays: recordCardPlays as ReturnType<typeof vi.fn>,
	progressForMatch: progressForMatch as ReturnType<typeof vi.fn>,
	progressWeeklyForMatch: progressWeeklyForMatch as ReturnType<typeof vi.fn>,
	progressUniqueForMatch: progressUniqueForMatch as ReturnType<typeof vi.fn>,
	progressForRankTier: progressForRankTier as ReturnType<typeof vi.fn>,
	getLevel: getLevel as ReturnType<typeof vi.fn>,
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

	it("short-circuits to confirmed if the match was already settled (idempotent retry), reading back the XP journaled on match_history", async () => {
		mocked.findMatchHistory.mockResolvedValue({
			id: 1,
			winner_id: 1,
			player1_id: 1,
			player2_id: 2,
			xp_awarded_player1: 50,
			xp_awarded_player2: 15,
		});
		mocked.getLevel.mockResolvedValue({ level: 3, xp: 20, xpToNext: 120 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.getLevel).toHaveBeenCalledWith(1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({ status: "confirmed", xpGained: 50, level: 3, xp: 20, xpToNext: 120 }),
		);
		expect(mocked.createReport).not.toHaveBeenCalled();
	});

	it("reads back the loser's own XP amount (not the winner's) on idempotent retry", async () => {
		mocked.findMatchHistory.mockResolvedValue({
			id: 1,
			winner_id: 2,
			player1_id: 1,
			player2_id: 2,
			xp_awarded_player1: 15,
			xp_awarded_player2: 50,
		});
		mocked.getLevel.mockResolvedValue({ level: 1, xp: 15, xpToNext: 100 });
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 2 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmed", xpGained: 15 }));
	});

	describe("matchSessionToken (TODO.md P9 anti-cheat)", () => {
		const originalSecret = process.env.TOKEN_SECRET;
		const originalEnforce = process.env.ENFORCE_MATCH_SESSION_TOKEN;

		beforeEach(() => {
			process.env.TOKEN_SECRET = "test-secret";
		});
		afterEach(() => {
			process.env.TOKEN_SECRET = originalSecret;
			process.env.ENFORCE_MATCH_SESSION_TOKEN = originalEnforce;
		});

		it("soft mode (default): proceeds even without a token, missing report only logged", async () => {
			delete process.env.ENFORCE_MATCH_SESSION_TOKEN;
			mocked.findMatchHistory.mockResolvedValue(null);
			mocked.findReport.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
			const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
			const res = mockRes();

			await reportMatch(req, res);

			expect(res.status).toHaveBeenCalledWith(202);
			expect(mocked.createReport).toHaveBeenCalled();
		});

		it("enforce mode: rejects a report with no token", async () => {
			process.env.ENFORCE_MATCH_SESSION_TOKEN = "true";
			const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
			const res = mockRes();

			await reportMatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(mocked.createReport).not.toHaveBeenCalled();
		});

		it("enforce mode: rejects a token issued for a different pair of players", async () => {
			process.env.ENFORCE_MATCH_SESSION_TOKEN = "true";
			const token = issueMatchSessionToken("m1", 1, 999); // not opponentId=2
			const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1, matchSessionToken: token });
			const res = mockRes();

			await reportMatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(mocked.createReport).not.toHaveBeenCalled();
		});

		it("enforce mode: rejects a valid token whose matchId doesn't match the declared clientMatchId", async () => {
			process.env.ENFORCE_MATCH_SESSION_TOKEN = "true";
			const token = issueMatchSessionToken("m-other", 1, 2);
			const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1, matchSessionToken: token });
			const res = mockRes();

			await reportMatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(mocked.createReport).not.toHaveBeenCalled();
		});

		it("enforce mode: accepts a valid, matching token", async () => {
			process.env.ENFORCE_MATCH_SESSION_TOKEN = "true";
			const token = issueMatchSessionToken("m1", 1, 2);
			mocked.findMatchHistory.mockResolvedValue(null);
			mocked.findReport.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
			const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1, matchSessionToken: token });
			const res = mockRes();

			await reportMatch(req, res);

			expect(res.status).toHaveBeenCalledWith(202);
			expect(mocked.createReport).toHaveBeenCalled();
		});
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

		expect(mocked.createReport).toHaveBeenCalledWith("m1", 1, 2, 1, null, null, null);
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

	it("confirms the match once both reports agree, returning the caller's XP gain and new level state", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ opponent_id: 1, winner_id: 1 });
		mocked.confirmMatch.mockResolvedValue({
			xpGained: 50,
			level: 4,
			xp: 5,
			xpToNext: 130,
			rewards: [],
			ratingA: 1016,
			ratingB: 984,
		});
		const req = reqAs(1, { clientMatchId: "m1", opponentId: 2, winnerId: 1 });
		const res = mockRes();

		await reportMatch(req, res);

		expect(mocked.confirmMatch).toHaveBeenCalledWith("m1", 1, 2, 1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({ status: "confirmed", xpGained: 50, level: 4, xp: 5, xpToNext: 130, rewards: [] }),
		);
	});

	it("progresses quests for both players once confirmed, with the correct win/loss flag each", async () => {
		mocked.findMatchHistory.mockResolvedValue(null);
		mocked.findReport
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ opponent_id: 1, winner_id: 1 });
		mocked.confirmMatch.mockResolvedValue({
			xpGained: 50,
			level: 1,
			xp: 50,
			xpToNext: 100,
			rewards: [],
			ratingA: 1016,
			ratingB: 984,
		});
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
		mocked.confirmMatch.mockResolvedValue({
			xpGained: 50,
			level: 1,
			xp: 50,
			xpToNext: 100,
			rewards: [],
			ratingA: 1016,
			ratingB: 984,
		});
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
		mocked.getLeaderboard.mockResolvedValue({ total: 0, players: [] });
		const req = { query: { limit: "9999", offset: "0" } } as unknown as Request;
		const res = mockRes();

		await getLeaderboardHandler(req, res);

		expect(mocked.getLeaderboard).toHaveBeenCalledWith(100, 0, undefined, undefined);
	});

	it("falls back to sane defaults for missing/invalid query params", async () => {
		mocked.getLeaderboard.mockResolvedValue({ total: 0, players: [] });
		const req = { query: {} } as unknown as Request;
		const res = mockRes();

		await getLeaderboardHandler(req, res);

		expect(mocked.getLeaderboard).toHaveBeenCalledWith(50, 0, undefined, undefined);
	});

	it("forwards minMmr/maxMmr tier bounds to the model", async () => {
		mocked.getLeaderboard.mockResolvedValue({ total: 0, players: [] });
		const req = { query: { minMmr: "1300", maxMmr: "1600" } } as unknown as Request;
		const res = mockRes();

		await getLeaderboardHandler(req, res);

		expect(mocked.getLeaderboard).toHaveBeenCalledWith(50, 0, 1300, 1600);
	});
});

describe("getMyLeaderboardPositionHandler", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns 401 when not authenticated", async () => {
		const req = { query: {} } as unknown as Request;
		const res = mockRes();

		await getMyLeaderboardPositionHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("returns 404 when the player is unranked", async () => {
		mocked.getMyLeaderboardPosition.mockResolvedValue(null);
		const req = reqAs(1, {});
		const res = mockRes();

		await getMyLeaderboardPositionHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(404);
	});

	it("returns the player's rank row when ranked", async () => {
		mocked.getMyLeaderboardPosition.mockResolvedValue({ user_id: 1, mmr: 1500, rank: 42 });
		const req = reqAs(1, {});
		const res = mockRes();

		await getMyLeaderboardPositionHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ user_id: 1, mmr: 1500, rank: 42 });
	});
});

describe("searchLeaderboardHandler", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns an empty array for a blank query without hitting the model", async () => {
		const req = { query: { q: "  " } } as unknown as Request;
		const res = mockRes();

		await searchLeaderboardHandler(req, res);

		expect(mocked.searchLeaderboard).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith([]);
	});

	it("forwards a trimmed query to the model", async () => {
		mocked.searchLeaderboard.mockResolvedValue([{ user_id: 2, username: "Foo" }]);
		const req = { query: { q: "Foo" } } as unknown as Request;
		const res = mockRes();

		await searchLeaderboardHandler(req, res);

		expect(mocked.searchLeaderboard).toHaveBeenCalledWith("Foo");
		expect(res.status).toHaveBeenCalledWith(200);
	});
});
