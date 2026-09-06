import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import db from "./db";
import { getStats } from "./rankedModel";

// Fenêtre d'appariement élargie progressivement pour éviter des temps
// d'attente indéfinis avec peu de joueurs simultanés — voir le contrat
// d'origine (docs/backend-contracts/ranked-matchmaking-and-retention.md,
// côté card-game) : ±100 MMR au départ, +50 toutes les 15s, plafond ±500.
const WINDOW_BASE_MMR = 100;
const WINDOW_STEP_MMR = 50;
const WINDOW_STEP_SECONDS = 15;
const WINDOW_MAX_MMR = 500;

// Un ticket sans appariement après ce délai passe en expired. Le client
// abandonne de son côté après 3 min (RANKED_QUEUE_TIMEOUT dans NetLobby.gd) :
// cette valeur n'a donc pas besoin d'être plus courte que ça.
const TICKET_EXPIRY_SECONDS = 300;

interface TicketRow extends RowDataPacket {
	id: number;
	ticket_id: string;
	user_id: number;
	mmr: number;
	status: "waiting" | "matched" | "cancelled" | "expired";
	opponent_id: number | null;
	role: "host" | "guest" | null;
	steam_lobby_id: string | null;
	created_at: string;
}

type QueueStatusResult =
	| { status: "waiting" }
	| { status: "matched"; role: "host" | "guest"; opponent_id: number; steam_lobby_id?: number }
	| { status: "cancelled" }
	| { status: "expired" };

const elapsedSeconds = (createdAt: string): number => (Date.now() - new Date(createdAt).getTime()) / 1000;

const windowFor = (elapsed: number): number =>
	Math.min(WINDOW_BASE_MMR + Math.floor(elapsed / WINDOW_STEP_SECONDS) * WINDOW_STEP_MMR, WINDOW_MAX_MMR);

// Cherche un adversaire compatible parmi les autres tickets en attente,
// verrouillés FOR UPDATE pour qu'un même adversaire ne puisse pas être
// apparié deux fois par deux requêtes concurrentes (join + poll d'un tiers en
// même temps). La fenêtre retenue est la plus large des deux côtés : un
// joueur qui attend depuis longtemps élargit sa propre fenêtre, suffisant pour
// matcher même si l'autre vient d'arriver.
const findOpponent = async (connection: PoolConnection, ticket: TicketRow): Promise<TicketRow | null> => {
	const [candidates] = await connection.query<TicketRow[]>(
		"SELECT * FROM matchmaking_tickets WHERE status = 'waiting' AND user_id != ? ORDER BY created_at ASC FOR UPDATE",
		[ticket.user_id],
	);
	const myWindow = windowFor(elapsedSeconds(ticket.created_at));
	for (const candidate of candidates) {
		const window = Math.max(myWindow, windowFor(elapsedSeconds(candidate.created_at)));
		if (Math.abs(candidate.mmr - ticket.mmr) <= window) return candidate;
	}
	return null;
};

// Désigne l'hôte de façon déterministe (le plus petit user_id) et marque les
// deux tickets matched en une fois — appelé sous transaction avec les deux
// lignes déjà verrouillées (l'une par le SELECT ... FOR UPDATE de l'appelant,
// l'autre par le FOR UPDATE de findOpponent).
const pairTickets = async (connection: PoolConnection, ticket: TicketRow, opponent: TicketRow): Promise<void> => {
	const hostId = Math.min(ticket.user_id, opponent.user_id);
	await connection.query(
		"UPDATE matchmaking_tickets SET status = 'matched', opponent_id = ?, role = ? WHERE id = ?",
		[opponent.user_id, ticket.user_id === hostId ? "host" : "guest", ticket.id],
	);
	await connection.query(
		"UPDATE matchmaking_tickets SET status = 'matched', opponent_id = ?, role = ? WHERE id = ?",
		[ticket.user_id, opponent.user_id === hostId ? "host" : "guest", opponent.id],
	);
};

// Rejoint la file : un seul ticket actif par joueur (UNIQUE KEY user_id),
// un second appel remplace le précédent plutôt que de créer un doublon.
// Tente immédiatement un appariement plutôt que d'attendre le prochain poll,
// pour matcher tout de suite si un adversaire compatible attend déjà.
const joinQueue = async (userId: number): Promise<string> => {
	const stats = await getStats(userId);
	const ticketId = randomUUID();
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		await connection.query(
			`INSERT INTO matchmaking_tickets (ticket_id, user_id, mmr, status)
			 VALUES (?, ?, ?, 'waiting')
			 ON DUPLICATE KEY UPDATE
			   ticket_id = VALUES(ticket_id), mmr = VALUES(mmr), status = 'waiting',
			   opponent_id = NULL, role = NULL, steam_lobby_id = NULL, created_at = CURRENT_TIMESTAMP`,
			[ticketId, userId, stats.mmr],
		);
		const [rows] = await connection.query<TicketRow[]>(
			"SELECT * FROM matchmaking_tickets WHERE user_id = ? FOR UPDATE",
			[userId],
		);
		const ticket = rows[0];
		const opponent = await findOpponent(connection, ticket);
		if (opponent) await pairTickets(connection, ticket, opponent);
		await connection.commit();
		return ticketId;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

const toStatusResult = (ticket: TicketRow): QueueStatusResult => {
	if (ticket.status === "matched") {
		return {
			status: "matched",
			role: ticket.role as "host" | "guest",
			opponent_id: ticket.opponent_id as number,
			steam_lobby_id: ticket.steam_lobby_id ? Number(ticket.steam_lobby_id) : undefined,
		};
	}
	if (ticket.status === "cancelled") return { status: "cancelled" };
	if (ticket.status === "expired") return { status: "expired" };
	return { status: "waiting" };
};

// Interroge l'état d'un ticket (poll client toutes les 2s). Retente un
// appariement à chaque appel tant que le ticket est en attente — c'est le
// même mécanisme que joinQueue, pas de job planifié séparé. Un ticket
// introuvable ou appartenant à un autre joueur est traité comme expiré,
// jamais comme une erreur (ticket_id est un UUID non devinable, mais autant
// ne rien exposer côté propriétaire).
const getQueueStatus = async (userId: number, ticketId: string): Promise<QueueStatusResult> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query<TicketRow[]>(
			"SELECT * FROM matchmaking_tickets WHERE ticket_id = ? FOR UPDATE",
			[ticketId],
		);
		const ticket = rows[0];
		if (!ticket || ticket.user_id !== userId) {
			await connection.commit();
			return { status: "expired" };
		}

		if (ticket.status === "waiting" && elapsedSeconds(ticket.created_at) >= TICKET_EXPIRY_SECONDS) {
			await connection.query("UPDATE matchmaking_tickets SET status = 'expired' WHERE id = ?", [ticket.id]);
			await connection.commit();
			return { status: "expired" };
		}

		if (ticket.status === "waiting") {
			const opponent = await findOpponent(connection, ticket);
			if (opponent) {
				await pairTickets(connection, ticket, opponent);
				const [refreshed] = await connection.query<TicketRow[]>(
					"SELECT * FROM matchmaking_tickets WHERE id = ?",
					[ticket.id],
				);
				await connection.commit();
				return toStatusResult(refreshed[0]);
			}
			await connection.commit();
			return { status: "waiting" };
		}

		await connection.commit();
		return toStatusResult(ticket);
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Hôte uniquement, juste après la création réussie du lobby Steam. Propage le
// steam_lobby_id sur les DEUX tickets (le sien et celui de l'adversaire) en
// une transaction : c'est le ticket de l'invité que celui-ci relit à son
// prochain poll pour rejoindre le lobby (voir getQueueStatus/toStatusResult).
// Renvoie false si l'appelant n'est pas l'hôte confirmé de ce ticket
// (ticket introuvable, pas le sien, pas encore matched, ou role != host).
const reportLobby = async (userId: number, ticketId: string, steamLobbyId: number): Promise<boolean> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query<TicketRow[]>(
			"SELECT * FROM matchmaking_tickets WHERE ticket_id = ? FOR UPDATE",
			[ticketId],
		);
		const ticket = rows[0];
		if (!ticket || ticket.user_id !== userId || ticket.status !== "matched" || ticket.role !== "host" || !ticket.opponent_id) {
			await connection.rollback();
			return false;
		}
		await connection.query("UPDATE matchmaking_tickets SET steam_lobby_id = ? WHERE id = ?", [steamLobbyId, ticket.id]);
		await connection.query(
			"UPDATE matchmaking_tickets SET steam_lobby_id = ? WHERE user_id = ? AND opponent_id = ?",
			[steamLobbyId, ticket.opponent_id, ticket.user_id],
		);
		await connection.commit();
		return true;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Annule un ticket (bouton Annuler, ou navigation hors de l'écran lobby).
// Idempotent par construction : ne touche qu'un ticket encore 'waiting'
// appartenant à l'appelant, un ticket déjà consommé/expiré/absent ne renvoie
// jamais d'erreur (voir le contrat, DELETE .../:ticket_id doit rester
// silencieux dans tous les cas).
const cancelQueue = async (userId: number, ticketId: string): Promise<void> => {
	await db.query(
		"UPDATE matchmaking_tickets SET status = 'cancelled' WHERE ticket_id = ? AND user_id = ? AND status = 'waiting'",
		[ticketId, userId],
	);
};

export { joinQueue, getQueueStatus, reportLobby, cancelQueue };
