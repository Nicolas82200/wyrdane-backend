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
import { joinQueue, getQueueStatus, reportLobby, abandonMatch, cancelQueue } from "./matchmakingModel";

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
	last_seen_at?: string;
}

const NOW = new Date("2026-09-06T12:00:00Z");

// query() générique : le SELECT (FOR UPDATE ou non) portant sur user_id = ?
// renvoie [ownTicket], celui listant les tickets 'waiting' des autres joueurs
// renvoie candidateRows ; tout le reste (INSERT/UPDATE) répond un succès
// générique inspecté ensuite via connection.query.mock.calls.
// steamId : valeur renvoyée par la jointure linked_accounts (identité de
// rendez-vous P2P, voir fetchSteamId côté modèle). null = compte sans SteamID lié.
const makeConnection = (ownTicket: TicketRow | null, candidateRows: TicketRow[] = [], steamId: string | null = null) => {
	const connection = {
		query: vi.fn(),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	};
	connection.query.mockImplementation((sql: unknown) => {
		if (typeof sql !== "string") return Promise.resolve([[]]);
		// Avant les branches génériques : ce SELECT contient lui aussi "user_id = ?".
		if (sql.includes("linked_accounts")) {
			return Promise.resolve([steamId === null ? [] : [{ external_id: steamId }]]);
		}
		if (sql.includes("user_id != ?")) return Promise.resolve([candidateRows]);
		if (sql.includes("WHERE user_id = ?") || sql.includes("WHERE ticket_id = ?") || sql.includes("WHERE id = ?")) {
			return Promise.resolve([ownTicket ? [ownTicket] : []]);
		}
		return Promise.resolve([{}]);
	});
	return connection;
};

// Les tests de sélection ci-dessous manipulent plusieurs candidats à la fois :
// une fabrique évite d'en recopier le détail quatre fois. createdAtOffsetSeconds
// négatif = ticket plus ancien (en attente depuis plus longtemps).
const waitingTicket = (id: number, mmr: number, createdAtOffsetSeconds = 0): TicketRow => ({
	id,
	ticket_id: `t${id}`,
	user_id: id,
	mmr,
	status: "waiting",
	opponent_id: null,
	role: null,
	steam_lobby_id: null,
	match_id: null,
	match_session_token: null,
	created_at: new Date(NOW.getTime() + createdAtOffsetSeconds * 1000).toISOString(),
	last_seen_at: NOW.toISOString(),
});

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

		it("picks the closest MMR among several eligible candidates", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.1);
			const myTicket = waitingTicket(1, 1000);
			// Tous arrivés en même temps : aucun bonus d'ancienneté ne s'applique,
			// seul l'écart de MMR départage. 1020 est le plus proche de 1000.
			const connection = makeConnection(myTicket, [
				waitingTicket(2, 1090),
				waitingTicket(3, 1020),
				waitingTicket(4, 1050),
			]);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1, "ranked");

			const myUpdate = findUpdate(
				connection,
				(sql, params) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'") && params[4] === 1,
			);
			expect((myUpdate as unknown[])[0]).toBe(3);
			randomSpy.mockRestore();
		});

		it("prefers a long-waiting candidate over a closer one that just arrived", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.1);
			const myTicket = waitingTicket(1, 1000);
			// user 3 est plus loin en MMR (90 d'écart contre 20) mais attend depuis
			// 60s : son bonus d'ancienneté (60 x 5, plafonné à 300) lui donne un score
			// de -210 contre 20, il passe donc devant. Il reste dans la fenêtre, que
			// son attente a élargie à +/-300.
			const connection = makeConnection(myTicket, [waitingTicket(3, 1090, -60), waitingTicket(2, 1020)]);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1, "ranked");

			const myUpdate = findUpdate(
				connection,
				(sql, params) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'") && params[4] === 1,
			);
			expect((myUpdate as unknown[])[0]).toBe(3);
			randomSpy.mockRestore();
		});

		it("does not let a short wait override a much closer MMR", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.1);
			const myTicket = waitingTicket(1, 1000);
			// user 2 est le plus ancien (5s) donc le premier de la liste, et c'est lui
			// que l'ancienne sélection « premier éligible » retenait. Son bonus
			// d'ancienneté ne vaut ici que 25 points (5s x 5), score 90 - 25 = 65,
			// contre 5 pour user 3 qui vient d'arriver mais n'est qu'à 5 points de
			// MMR : la proximité doit gagner. Garde-fou sur le réglage du bonus.
			const connection = makeConnection(myTicket, [waitingTicket(2, 1090, -5), waitingTicket(3, 1005)]);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1, "ranked");

			const myUpdate = findUpdate(
				connection,
				(sql, params) => sql.startsWith("UPDATE matchmaking_tickets SET status = 'matched'") && params[4] === 1,
			);
			expect((myUpdate as unknown[])[0]).toBe(3);
			randomSpy.mockRestore();
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

	// Régressions du rendez-vous Steam : les deux causes pour lesquelles deux amis
	// n'arrivaient plus à entrer en partie ensemble (code 2 en boucle).
	describe("rendezvous safety", () => {
		it("clears any inherited steam_lobby_id when pairing", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			vi.spyOn(Math, "random").mockReturnValue(0.1);
			// Ticket réutilisé (UNIQUE KEY user_id) portant encore le lobby du match
			// précédent : sans purge, l'invité le relisait et rejoignait un lobby mort.
			const myTicket: TicketRow = {
				...waitingTicket(1, 1000),
				steam_lobby_id: "109775243148705323",
			};
			const connection = makeConnection(myTicket, [waitingTicket(2, 1010)]);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1, "normal");

			const pairingSql = connection.query.mock.calls
				.map(([sql]) => sql)
				.filter((sql): sql is string => typeof sql === "string" && sql.includes("status = 'matched'"));
			expect(pairingSql.length).toBe(2);
			for (const sql of pairingSql) expect(sql).toContain("steam_lobby_id = NULL");
		});

		it("never pairs with a ticket older than the expiry window", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const connection = makeConnection(waitingTicket(1, 1000), []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1, "normal");

			// Un ticket ne passe 'expired' que si son propriétaire le poll : la borne
			// doit donc être dans le SQL, sinon un joueur qui a fermé le jeu reste
			// appariable indéfiniment.
			const candidateCall = connection.query.mock.calls.find(
				([sql]) => typeof sql === "string" && sql.includes("user_id != ?"),
			);
			expect(candidateCall?.[0]).toContain("created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)");
			// Seconde borne, celle qui écarte réellement un joueur parti : il ne suffit
			// pas que son ticket soit récent, il faut qu'il l'ait pollé récemment.
			expect(candidateCall?.[0]).toContain("last_seen_at > DATE_SUB(NOW(), INTERVAL ? SECOND)");
			// Le mode vient de la ligne en base (waitingTicket ne le simule pas) : ce qui
			// compte ici est l'exclusion de soi-même, la borne d'expiration
			// (TICKET_EXPIRY_SECONDS) et la borne de vivacité (CANDIDATE_LIVENESS_SECONDS).
			expect(candidateCall?.[1]?.slice(1)).toEqual([1, 300, 12]);
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

		it("reports own mmr and widening window while still waiting", async () => {
			// 20s écoulées : fenêtre élargie une fois (WINDOW_STEP_SECONDS = 15) ->
			// WINDOW_BASE_MMR (100) + WINDOW_STEP_MMR (50) = 150.
			const waitingTicket: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1234,
				status: "waiting",
				opponent_id: null,
				role: null,
				steam_lobby_id: null,
				match_id: null,
				match_session_token: null,
				created_at: new Date(NOW.getTime() - 20_000).toISOString(),
			};
			const connection = makeConnection(waitingTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const result = await getQueueStatus(1, "t1");

			expect(result).toEqual({ status: "waiting", mmr: 1234, window: 150, elapsed_seconds: 20 });
		});

		// L'id est renvoyé en string, sans repasser par un number : le CSteamID
		// 64 bits 109775241000123456 devenait 109775241000123460 en double, et
		// l'invité rejoignait un lobby inexistant (Steam code 2).
		it("reports the guest's steam_lobby_id as an exact string once matched", async () => {
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
				steam_lobby_id: "109775241000123456",
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

			const ok = await reportLobby(1, "t1", "109775241000123456");

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
				match_id: "match-abc",
				match_session_token: "mock-session-token",
				created_at: NOW.toISOString(),
			};
			const connection = makeConnection(hostTicket, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const ok = await reportLobby(1, "t1", "109775241000123456");

			expect(ok).toBe(true);
			expect(findUpdate(connection, (sql) => sql === "UPDATE matchmaking_tickets SET steam_lobby_id = ? WHERE id = ?")).toEqual([
				"109775241000123456",
				1,
			]);
			// Le ticket de l'invité n'est touché que s'il est encore sur CE match :
			// les gardes status/match_id empêchent un réessai tardif d'écrire un lobby
			// périmé sur un adversaire déjà ré-apparié ailleurs.
			expect(
				findUpdate(connection, (sql) =>
					sql.includes("WHERE user_id = ? AND opponent_id = ? AND status = 'matched' AND match_id = ?"),
				),
			).toEqual(["109775241000123456", 2, 1, "match-abc"]);
			expect(connection.commit).toHaveBeenCalledTimes(1);
		});
	});

	describe("abandonMatch", () => {
		const matchedTicket = (role: string): TicketRow => ({
			id: 1,
			ticket_id: "t1",
			user_id: 1,
			mmr: 1000,
			status: "matched",
			opponent_id: 2,
			role,
			steam_lobby_id: "109775241000123456",
			match_id: "match-abc",
			match_session_token: "mock-session-token",
			created_at: NOW.toISOString(),
		});

		// Le point du correctif : les DEUX tickets repartent en file d'un seul coup.
		// Avant, seul celui qui échouait se remettait en file et son adversaire
		// restait 'matched' (donc non appariable) pendant tout son
		// HOST_PEER_WAIT_TIMEOUT — ils ne pouvaient plus se retrouver.
		it("puts both tickets of the match back in the queue", async () => {
			const connection = makeConnection(matchedTicket("guest"), []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const ok = await abandonMatch(1, "t1");

			expect(ok).toBe(true);
			const params = findUpdate(connection, (sql) => sql.includes("WHERE match_id = ?"));
			expect(params).toEqual(["match-abc"]);
			// Purge complète : un lobby résiduel rejouerait exactement le bug d'origine.
			const sql = connection.query.mock.calls.find(
				([text]) => typeof text === "string" && text.includes("WHERE match_id = ?"),
			)?.[0] as string;
			expect(sql).toContain("status = 'waiting'");
			expect(sql).toContain("steam_lobby_id = NULL");
			expect(sql).toContain("match_id = NULL");
			expect(sql).toContain("created_at = CURRENT_TIMESTAMP");
			expect(connection.commit).toHaveBeenCalledTimes(1);
		});

		it("refuses a ticket that is not matched and changes nothing", async () => {
			const waiting = waitingTicket(1, 1000);
			const connection = makeConnection(waiting, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const ok = await abandonMatch(1, "t1");

			expect(ok).toBe(false);
			expect(findUpdate(connection, (sql) => sql.includes("WHERE match_id = ?"))).toBeUndefined();
			expect(connection.rollback).toHaveBeenCalledTimes(1);
		});

		it("refuses a ticket that belongs to someone else", async () => {
			const connection = makeConnection(matchedTicket("host"), []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const ok = await abandonMatch(999, "t1");

			expect(ok).toBe(false);
			expect(findUpdate(connection, (sql) => sql.includes("WHERE match_id = ?"))).toBeUndefined();
			expect(connection.rollback).toHaveBeenCalledTimes(1);
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

	// Le rendez-vous ne passe plus par un lobby Steam publié après coup : le
	// backend renvoie directement le SteamID64 de l'adversaire, seule adresse dont
	// les deux clients ont besoin pour ouvrir leur connexion P2P (voir
	// SteamTransport côté card-game). Ces tests verrouillent ce contrat.
	describe("rendez-vous par identité Steam", () => {
		const pairedTicket = (): TicketRow => ({
			id: 1,
			ticket_id: "t1",
			user_id: 1,
			mmr: 1000,
			status: "matched",
			opponent_id: 2,
			role: "guest",
			steam_lobby_id: null,
			match_id: "m-1",
			match_session_token: "tok",
			created_at: NOW.toISOString(),
			last_seen_at: NOW.toISOString(),
		});

		it("renvoie le SteamID64 de l'adversaire sur un ticket apparié", async () => {
			const connection = makeConnection(pairedTicket(), [], "76561198000000001");
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const result = await getQueueStatus(1, "t1");

			expect(result).toMatchObject({
				status: "matched",
				role: "guest",
				opponent_steam_id: "76561198000000001",
			});
		});

		it("laisse opponent_steam_id absent si l'adversaire n'a pas de compte Steam lié", async () => {
			// Cas réel : un compte créé côté site n'a pas forcément de SteamID. Le
			// client doit pouvoir le constater et rendre l'appariement, plutôt que de
			// tenter une connexion P2P vers une identité nulle.
			const connection = makeConnection(pairedTicket(), [], null);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			const result = await getQueueStatus(1, "t1");

			expect((result as { opponent_steam_id?: string }).opponent_steam_id).toBeUndefined();
		});

		it("enregistre le poll comme signe de vie du ticket", async () => {
			const connection = makeConnection(waitingTicket(1, 1000), []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await getQueueStatus(1, "t1");

			expect(findUpdate(connection, (sql) => sql.includes("SET last_seen_at = NOW()"))).toEqual([1]);
		});
	});

	// Relancer une recherche alors qu'on était déjà apparié doit libérer
	// l'adversaire côté serveur : le client appelle bien /abandon, mais les deux
	// requêtes HTTP sont indépendantes et rien ne garantit leur ordre d'arrivée.
	describe("joinQueue libère un appariement mort", () => {
		it("remet l'adversaire en file quand le ticket remplacé était apparié", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const previous: TicketRow = {
				id: 1,
				ticket_id: "t1",
				user_id: 1,
				mmr: 1000,
				status: "matched",
				opponent_id: 2,
				role: "host",
				steam_lobby_id: null,
				match_id: "m-dead",
				match_session_token: "tok",
				created_at: NOW.toISOString(),
				last_seen_at: NOW.toISOString(),
			};
			const connection = makeConnection(previous, []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1, "normal");

			// Ciblé par match_id, et jamais sur notre propre ligne (que l'INSERT ...
			// ON DUPLICATE écrase juste après de toute façon).
			expect(findUpdate(connection, (sql) => sql.includes("WHERE match_id = ? AND user_id != ?"))).toEqual([
				"m-dead",
				1,
			]);
		});

		it("ne touche à rien quand le ticket remplacé était simplement en attente", async () => {
			mockedGetStats.mockResolvedValueOnce({ mmr: 1000 });
			const connection = makeConnection(waitingTicket(1, 1000), []);
			mockedDb.getConnection.mockResolvedValueOnce(connection);

			await joinQueue(1, "normal");

			expect(findUpdate(connection, (sql) => sql.includes("WHERE match_id = ? AND user_id != ?"))).toBeUndefined();
		});
	});
});
