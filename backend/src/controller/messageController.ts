import { Request, Response } from "express";

import { findFriendship } from "../model/friendModel";
import {
	MAX_BODY_LENGTH,
	sendMessage,
	getConversation,
	getConversations,
	markConversationRead,
	getUnreadTotal,
} from "../model/messageModel";
import { getUserId } from "../helper/requestUser";

// Le chat est réservé aux amis (voir CLAUDE.md « Système d'amis Wyrdane +
// chat ») : partagé par send/getConversation/markRead, jamais par
// getConversations/getUnreadTotal (qui ne listent que des conversations déjà
// existantes, donc forcément entre amis au moment de l'envoi).
const requireFriend = async (userId: number, otherId: number): Promise<boolean> => {
	const friendship = await findFriendship(userId, otherId);
	return friendship !== null && friendship.status === "accepted";
};

const send = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const { recipientId, body } = req.body as { recipientId?: number; body?: string };
		const targetId = Number(recipientId);
		if (!Number.isInteger(targetId) || targetId <= 0) {
			res.status(400).json({ message: "recipientId invalide" });
			return;
		}
		if (!body || !body.trim()) {
			res.status(400).json({ message: "Message vide" });
			return;
		}
		if (body.length > MAX_BODY_LENGTH) {
			res.status(400).json({ message: "Message trop long" });
			return;
		}
		if (!(await requireFriend(userId, targetId))) {
			res.status(403).json({ message: "Vous n'êtes pas ami avec ce joueur" });
			return;
		}
		const message = await sendMessage(userId, targetId, body);
		res.status(200).json(message);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const conversation = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const friendId = Number(req.params.friendId);
		if (!Number.isInteger(friendId)) {
			res.status(400).json({ message: "friendId invalide" });
			return;
		}
		const limit = Math.min(Number(req.query.limit) || 50, 100);
		const beforeId = req.query.beforeId !== undefined ? Number(req.query.beforeId) : undefined;
		const messages = await getConversation(userId, friendId, limit, beforeId);
		res.status(200).json(messages);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const conversations = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const list = await getConversations(userId);
		res.status(200).json(list);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const markRead = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const friendId = Number(req.params.friendId);
		if (!Number.isInteger(friendId)) {
			res.status(400).json({ message: "friendId invalide" });
			return;
		}
		await markConversationRead(userId, friendId);
		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const unreadTotal = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const total = await getUnreadTotal(userId);
		res.status(200).json({ total });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { send, conversation, conversations, markRead, unreadTotal };
