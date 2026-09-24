import type { RowDataPacket, ResultSetHeader } from "mysql2";
import db from "./db";

const MAX_BODY_LENGTH = 500;

interface MessageRow extends RowDataPacket {
	id: number;
	sender_id: number;
	recipient_id: number;
	body: string;
	created_at: string;
	read_at: string | null;
}

interface ConversationRow extends RowDataPacket {
	partner_id: number;
	username: string;
	last_message: string;
	last_message_at: string;
	last_sender_id: number;
	unread_count: number;
}

// Envoie un message — la vérification que l'expéditeur et le destinataire
// sont bien amis (le chat est réservé aux amis, voir CLAUDE.md « Système
// d'amis Wyrdane + chat ») est faite côté controller (friendModel.findFriendship),
// pas ici : ce modèle reste une simple couche de persistance.
const sendMessage = async (senderId: number, recipientId: number, body: string): Promise<MessageRow> => {
	const trimmed = body.trim().slice(0, MAX_BODY_LENGTH);
	const [result] = await db.query<ResultSetHeader>(
		"INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)",
		[senderId, recipientId, trimmed],
	);
	const [rows] = await db.query<MessageRow[]>("SELECT * FROM messages WHERE id = ?", [result.insertId]);
	return rows[0];
};

// Historique paginé d'une conversation avec un ami donné, le plus récent en
// tête (le client réaffiche dans l'ordre inverse) — beforeId permet de
// remonter plus loin dans l'historique (infinite scroll), voir ChatWindow.gd.
const getConversation = async (
	userId: number,
	friendId: number,
	limit = 50,
	beforeId?: number,
): Promise<MessageRow[]> => {
	const hasBefore = typeof beforeId === "number";
	const [rows] = await db.query<MessageRow[]>(
		`SELECT * FROM messages
		 WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
		 ${hasBefore ? "AND id < ?" : ""}
		 ORDER BY id DESC
		 LIMIT ?`,
		[userId, friendId, friendId, userId, ...(hasBefore ? [beforeId] : []), limit],
	);
	return rows;
};

// Liste des conversations ayant au moins un message échangé, la plus récente
// en tête (voir demande utilisateur "les conversations les plus récentes en
// haut") — un ami jamais contacté n'apparaît pas ici (voir friendModel.getFriends
// pour la liste d'amis complète, indépendante de tout historique de chat).
const getConversations = async (userId: number): Promise<ConversationRow[]> => {
	const [rows] = await db.query<ConversationRow[]>(
		`SELECT partner_id, u.username, m.body AS last_message, m.created_at AS last_message_at,
		        m.sender_id AS last_sender_id,
		        COALESCE(unread.unread_count, 0) AS unread_count
		 FROM (
		   SELECT partner_id, MAX(id) AS last_id
		   FROM (
		     SELECT id, CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS partner_id
		     FROM messages
		     WHERE sender_id = ? OR recipient_id = ?
		   ) x
		   GROUP BY partner_id
		 ) latest
		 JOIN messages m ON m.id = latest.last_id
		 JOIN users u ON u.id = latest.partner_id
		 LEFT JOIN (
		   SELECT sender_id AS partner_id, COUNT(*) AS unread_count
		   FROM messages
		   WHERE recipient_id = ? AND read_at IS NULL
		   GROUP BY sender_id
		 ) unread ON unread.partner_id = latest.partner_id
		 ORDER BY m.created_at DESC`,
		[userId, userId, userId, userId],
	);
	return rows;
};

// Marque comme lus tous les messages reçus d'un ami donné (appelé à
// l'ouverture de la fenêtre de chat avec cet ami) — ne touche jamais les
// messages qu'on a soi-même envoyés.
const markConversationRead = async (userId: number, friendId: number): Promise<void> => {
	await db.query(
		"UPDATE messages SET read_at = NOW() WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL",
		[userId, friendId],
	);
};

// Nombre total de messages non lus tous amis confondus — alimente le badge
// du bouton Chat du menu principal (voir demande utilisateur "un rond rouge
// et un nombre x").
const getUnreadTotal = async (userId: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { total: number })[]>(
		"SELECT COUNT(*) AS total FROM messages WHERE recipient_id = ? AND read_at IS NULL",
		[userId],
	);
	return rows[0]?.total ?? 0;
};

export { MAX_BODY_LENGTH, sendMessage, getConversation, getConversations, markConversationRead, getUnreadTotal };
