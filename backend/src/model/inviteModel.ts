import type { RowDataPacket, ResultSetHeader } from "mysql2";
import db from "./db";
import { findFriendship, ONLINE_WINDOW_SECONDS } from "./friendModel";

// Une invitation pending sans réponse au-delà de ce délai est traitée comme
// expirée (vérifié paresseusement à la lecture, même principe que
// matchmakingModel.TICKET_EXPIRY_SECONDS — pas de job planifié). Volontairement
// court : contrairement au matchmaking (adversaire anonyme, patience plus
// longue), il s'agit ici d'inviter un ami précis censé être en ligne au moment
// de l'invitation — voir card-game CLAUDE.md « Amis et chat ».
const INVITE_EXPIRY_SECONDS = 45;

type InviteStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

interface InviteRow extends RowDataPacket {
	id: number;
	sender_id: number;
	recipient_id: number;
	status: InviteStatus;
	steam_lobby_id: string;
	created_at: string;
	responded_at: string | null;
}

interface IncomingInviteRow extends RowDataPacket {
	id: number;
	sender_id: number;
	sender_username: string;
	steam_lobby_id: string;
	created_at: string;
}

type CreateInviteResult =
	| { ok: true; invite: InviteRow }
	| { ok: false; reason: "not_friends" | "recipient_unavailable" };

const elapsedSeconds = (createdAt: string): number => (Date.now() - new Date(createdAt).getTime()) / 1000;

// Expire en masse les invitations pending trop vieilles adressées à ce
// destinataire — appelé avant toute lecture côté destinataire (getIncomingInvites)
// pour qu'un poll ne remonte jamais une invitation périmée. Portée volontairement
// réduite à un seul recipient_id : pas besoin de balayer toute la table pour ça.
const expireStaleForRecipient = async (recipientId: number): Promise<void> => {
	await db.query(
		`UPDATE game_invites SET status = 'expired'
		 WHERE recipient_id = ? AND status = 'pending' AND created_at < NOW() - INTERVAL ? SECOND`,
		[recipientId, INVITE_EXPIRY_SECONDS],
	);
};

// Crée une invitation. Annule d'abord toute invitation pending déjà envoyée
// par cet expéditeur (un seul envoi actif à la fois, évite le spam d'un même
// joueur vers plusieurs amis en même temps) — même logique que
// matchmakingModel.joinQueue qui remplace le ticket précédent plutôt que d'en
// accumuler. steamLobbyId est déjà connu de l'appelant : l'hôte a créé son
// lobby Steam AVANT d'inviter (voir MatchmakingOverlay.gd), ce endpoint ne
// fait que le relayer au destinataire.
const createInvite = async (
	senderId: number,
	recipientId: number,
	steamLobbyId: number,
): Promise<CreateInviteResult> => {
	const friendship = await findFriendship(senderId, recipientId);
	if (!friendship || friendship.status !== "accepted") return { ok: false, reason: "not_friends" };

	const [recipientRows] = await db.query<RowDataPacket[]>(
		`SELECT in_game, last_heartbeat_at,
		   (last_heartbeat_at IS NOT NULL AND last_heartbeat_at >= NOW() - INTERVAL ? SECOND) AS is_online
		 FROM users WHERE id = ?`,
		[ONLINE_WINDOW_SECONDS, recipientId],
	);
	const recipient = recipientRows[0];
	if (!recipient || !recipient.is_online || recipient.in_game) {
		return { ok: false, reason: "recipient_unavailable" };
	}

	await db.query("UPDATE game_invites SET status = 'cancelled' WHERE sender_id = ? AND status = 'pending'", [senderId]);
	const [result] = await db.query<ResultSetHeader>(
		"INSERT INTO game_invites (sender_id, recipient_id, steam_lobby_id, status) VALUES (?, ?, ?, 'pending')",
		[senderId, recipientId, steamLobbyId],
	);
	const [rows] = await db.query<InviteRow[]>("SELECT * FROM game_invites WHERE id = ?", [result.insertId]);
	return { ok: true, invite: rows[0] };
};

// Invitations pending reçues par ce joueur (polling côté destinataire, voir
// FriendsPanel/MatchmakingOverlay côté client) — expire d'abord les vieilles
// lignes pour ne jamais en renvoyer une périmée.
const getIncomingInvites = async (recipientId: number): Promise<IncomingInviteRow[]> => {
	await expireStaleForRecipient(recipientId);
	const [rows] = await db.query<IncomingInviteRow[]>(
		`SELECT gi.id, gi.sender_id, u.username AS sender_username, gi.steam_lobby_id, gi.created_at
		 FROM game_invites gi
		 JOIN users u ON u.id = gi.sender_id
		 WHERE gi.recipient_id = ? AND gi.status = 'pending'
		 ORDER BY gi.created_at DESC`,
		[recipientId],
	);
	return rows;
};

// État d'une invitation, relu par l'EXPÉDITEUR (poll pendant l'attente, voir
// MatchmakingOverlay.gd) pour savoir si son ami a répondu. N'importe qui
// d'autre que l'expéditeur reçoit "expired" plutôt qu'une erreur, même
// convention que matchmakingModel.getQueueStatus.
const getInviteStatus = async (senderId: number, inviteId: number): Promise<InviteStatus> => {
	const [rows] = await db.query<InviteRow[]>("SELECT * FROM game_invites WHERE id = ?", [inviteId]);
	const invite = rows[0];
	if (!invite || invite.sender_id !== senderId) return "expired";
	if (invite.status === "pending" && elapsedSeconds(invite.created_at) >= INVITE_EXPIRY_SECONDS) {
		await db.query("UPDATE game_invites SET status = 'expired' WHERE id = ?", [invite.id]);
		return "expired";
	}
	return invite.status;
};

// Répond à une invitation reçue (accepter/refuser) — seul le destinataire
// peut répondre, et seulement tant qu'elle est encore pending et non expirée.
// Renvoie l'invitation à jour (steam_lobby_id nécessaire côté client pour
// rejoindre le lobby en cas d'acceptation) ou null si la réponse n'a pas pu
// être appliquée (déjà répondue, expirée, ou pas le bon destinataire).
const respondInvite = async (
	recipientId: number,
	inviteId: number,
	accept: boolean,
): Promise<InviteRow | null> => {
	const [rows] = await db.query<InviteRow[]>("SELECT * FROM game_invites WHERE id = ?", [inviteId]);
	const invite = rows[0];
	if (!invite || invite.recipient_id !== recipientId || invite.status !== "pending") return null;
	if (elapsedSeconds(invite.created_at) >= INVITE_EXPIRY_SECONDS) {
		await db.query("UPDATE game_invites SET status = 'expired' WHERE id = ?", [invite.id]);
		return null;
	}
	const newStatus: InviteStatus = accept ? "accepted" : "declined";
	await db.query("UPDATE game_invites SET status = ?, responded_at = NOW() WHERE id = ?", [newStatus, invite.id]);
	return { ...invite, status: newStatus };
};

// Annule une invitation encore pending — bouton "Annuler" côté expéditeur, ou
// appelé automatiquement par le client après son propre timeout d'attente.
// Idempotent : ne touche qu'une ligne encore pending lui appartenant, jamais
// d'erreur sinon (même convention que matchmakingModel.cancelQueue).
const cancelInvite = async (senderId: number, inviteId: number): Promise<void> => {
	await db.query("UPDATE game_invites SET status = 'cancelled' WHERE id = ? AND sender_id = ? AND status = 'pending'", [
		inviteId,
		senderId,
	]);
};

export { INVITE_EXPIRY_SECONDS, createInvite, getIncomingInvites, getInviteStatus, respondInvite, cancelInvite };
export type { InviteStatus };
