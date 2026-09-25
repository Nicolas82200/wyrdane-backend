import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

vi.mock("./rankedModel", () => ({
	getStats: vi.fn(),
}));

// La génération réelle du jeton (JWT, TOKEN_SECRET) est testée séparément
// dans helper/matchSessionToken.test.ts — ici on vérifie seulement que
// pairTickets l'appelle et propage sa valeur aux deux tickets.
vi.mock("../helper/matchSessionToken", () => ({
	issueMatchSessionToken: vi.fn(() => "mock-session-token"),
}));

import db from "./db";
import { getStats } from "./rankedModel";
import { joinQueue, getQueueStatus, reportLobby, cancelQueue } from "./matchmakingModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn>; getConnection: ReturnType<typeof vi.fn> };
const mockedGetStats = getStats as unknown as ReturnType<typeof vi.fn>;

interface TicketRow {
	id: number;
	ticket_id: string;
	user_id: number;
	mmr: number;
	status: string;
	opponent_id: number | null;
	role: string | null;
	steam_lobby_id: string | null;
	match_id: string | null;
	match_session_token: string | null;
	created_at: string;
}

const NOW = new Date("2026-09-06T12:00:00Z");

// query() générique : le SELECT (FOR UPDATE ou non) portant sur user_id = ?
// renvoie [ownTicket], celui listant les tickets 'waiting' des autres joueurs
// renvoie candidateRows ; tout le reste (INSERT/UPDATE) répond un succès
// générique inspecté ensuite via connection.query.mock.calls.
const makeConnection = (ownTicket: TicketRow | null, candidateRows: TicketRow[] = []) => {
	const connection = {
		query: vi.fn(),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	};
	connection.query.mockImplementation((sql: unknown) => {
		if (typeof sql !== "string") return Promise.resolve([[]]);
		if (sql.includes("user_id != ?")) return Promise.resolve([candidateRows]);
		if (sql.includes("WHERE user_id = ?") || sql.includes("WHERE ticket_id = ?") || sql.includes("WHERE id = ?")) {
			return Promise.resolve([ownTicket ? [ownTicket] : []]);
		}
		return Promise.resolve([{}]);
	});
	return connection;
};

const findUpdate = (connection: { query: ReturnType<typeof vi.fn> }, predicate: (sql: string, params: unknown[]) => boolean) =>
	connection.query.mock.calls.find(
		([sql, params]) => typeof sql === "string" && Array.isArray(params) && predicate(sql, params),
	)?.[1] as unknown[] | undefined;

describe("matchmakingModel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	describe("joinQueue", () => {
		it("creates a waiting ticket when no compatible opponent is queued", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const myTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1000,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(myTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const ticketId = await joinQueue(1);

			expect(typeof ticketId).toBe("string");
			expect(connection.commit).toHaveBeenCalledTimes(1);
			expect(findUpdate(connection, (sql) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'"))).toBeUndefined();
		});

		it("pairs immediately with a compatible waiting opponent, host chosen at random (>=0.5 -> opponent)", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.9);
			const myTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 5,
				mmr: 1000,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const opponent: TicketRow = {
				id: 2,
				ticket_id: "t2",
				user_id: 2,
				mmr: 1050,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(myTicket, [opponent]);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(5);

			// Math.random() mocké à 0.9 (>= 0.5) -> l'adversaire (user_id 2) est
			// désigné hôte, voir pairTickets. ticket.id est en dernière position
			// (params[4]) : matchId/jeton de session (params[2]/params[3])
			// s'insèrent avant.
			const myUpdate = findUpdate(connection, (sql, params) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'") && params[4] === 1);
			const opponentUpdate = findUpdate(connection, (sql, params) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'") && params[4] === 2);
			expect(myUpdate).toEqual([2, "guest", expect.any(String), "mock-session-token", 1]);
			expect(opponentUpdate).toEqual([5, "host", expect.any(String), "mock-session-token", 2]);
			// Les deux tickets appariés doivent partager exactement le même
			// matchId (même appel à issueMatchSessionToken), pas un par ticket.
			expect((myUpdate as unknown[])[2]).toEqual((opponentUpdate as unknown[])[2]);
			randomSpy.mockRestore();
		});

		it("pairs immediately with a compatible waiting opponent, host chosen at random (<0.5 -> caller)", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.1);
			const myTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 5,
				mmr: 1000,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const opponent: TicketRow = {
				id: 2,
				ticket_id: "t2",
				user_id: 2,
				mmr: 1050,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(myTicket, [opponent]);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(5);

			// Math.random() mocké à 0.1 (< 0.5) -> l'appelant (user_id 5, alors
			// même le plus GRAND des deux) est désigné hôte — preuve que ce n'est
			// plus déterministe sur le plus petit user_id.
			const myUpdate = findUpdate(connection, (sql, params) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'") && params[4] === 1);
			const opponentUpdate = findUpdate(connection, (sql, params) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'") && params[4] === 2);
			expect(myUpdate).toEqual([2, "host", expect.any(String), "mock-session-token", 1]);
			expect(opponentUpdate).toEqual([5, "guest", expect.any(String), "mock-session-token", 2]);
			randomSpy.mockRestore();
		});

		it("does not pair with an opponent outside the MMR window", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const myTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1000,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const farOpponent: TicketRow = {
				id: 2,
				ticket_id: "t2",
				user_id: 2,
				mmr: 1300,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(myTicket, [farOpponent]);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1);

			expect(findUpdate(connection, (sql) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'"))).toBeUndefined();
		});

		it("rolls back and rethrows if a query fails mid-transaction", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const connection = {
				query: vi.fn().mockRejectedValue(new Error("db exploded")),
				beginTransaction: vi.fn(),
				commit: vi.fn(),
				rollback: vi.fn(),
				release: vi.fn(),
			};
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await expect(joinQueue(1)).rejects.toThrow("db exploded");
			expect(connection.rollback).toHaveBeenCalledTimes(1);
			expect(connection.release).toHaveBeenCalledTimes(1);
		});
	});

	describe("getQueueStatus", () => {
		it("returns expired for a ticket that does not belong to the caller", async () => {
			const otherTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 999,
				mmr: 1000,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(otherTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const result = await getQueueStatus(1, "t1");

			expect(result).toEqual({ status: "expired" });
		});

		it("expires a waiting ticket past the timeout", async () => {
			const oldTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1000,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: new Date(NOW.getTime() - 301_000).toISOString(),
			};
			const connection = makeConnection(oldTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const result = await getQueueStatus(1, "t1");

			expect(result).toEqual({ status: "expired" });
			expect(findUpdate(connection, (sql) => sql === "UPDATE matchmaking_tickets SET status = 'expired' WHERE id = ?")).toEqual([1]);
		});

		it("reports the guest's steam_lobby_id once matched", async () => {
			const matchedTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1000,
				status: "matched",
				opponent_id: 2,
				role: "guest",
				steam_lobby_id: "109775241000123456",
				match_id: "match-abc",
				match_session_token: "mock-session-token",
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(matchedTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const result = await getQueueStatus(1, "t1");

			expect(result).toEqual({
				status: "matched",
				role: "guest",
				opponent_id: 2,
				steam_lobby_id: 109775241000123456,
				match_id: "match-abc",
				match_session_token: "mock-session-token",
			});
		});
	});

	describe("reportLobby", () => {
		it("rejects a caller who is not the confirmed host", async () => {
			const guestTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1000,
				status: "matched",
				opponent_id: 2,
				role: "guest",
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(guestTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const ok = await reportLobby(1, "t1", 109775241000123456);

			expect(ok).toBe(false);
			expect(connection.rollback).toHaveBeenCalledTimes(1);
		});

		it("propagates the lobby id to both tickets for the confirmed host", async () => {
			const hostTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1000,
				status: "matched",
				opponent_id: 2,
				role: "host",
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(hostTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const ok = await reportLobby(1, "t1", 109775241000123456);

			expect(ok).toBe(true);
			expect(findUpdate(connection, (sql) => sql === "UPDATE matchmaking_tickets SET steam_lobby_id = ? WHERE id = ?")).toEqual([
				109775241000123456,
				1,
			]);
			expect(
				findUpdate(connection, (sql) => sql === "UPDATE matchmaking_tickets SET steam_lobby_id = ? WHERE user_id = ? AND opponent_id = ?"),
			).toEqual([109775241000123456, 2, 1]);
			expect(connection.commit).toHaveBeenCalledTimes(1);
		});
	});

	describe("cancelQueue", () => {
		it("only cancels the caller's own waiting ticket", async () => {
			await cancelQueue(1, "t1");

			expect(mockedDb.query).toHaveBeenCalledWith(
				"UPDATE matchmaking_tickets SET status = 'cancelled' WHERE ticket_id = ? AND user_id = ? AND status = 'waiting'",
				["t1", 1],
			);
		});
	});
});
