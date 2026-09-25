import { Request, Response } from "express";

import { createInvite, getIncomingInvites, getInviteStatus, respondInvite, cancelInvite } from "../model/inviteModel";
import { getUserId } from "../helper/requestUser";

// POST /api/invites — l'expéditeur a déjà hébergé son lobby Steam côté client
// (voir MatchmakingOverlay.gd) avant d'appeler ceci, steamLobbyId est donc
// requis dès la création.
const create = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const body = req.body as { recipientId?: number; steamLobbyId?: number };
		const recipientId = Number(body.recipientId);
		const steamLobbyId = Number(body.steamLobbyId);
		if (!Number.isInteger(recipientId) || recipientId <= 0 || !Number.isInteger(steamLobbyId) || steamLobbyId <= 0) {
			res.status(400).json({ message: "recipientId/steamLobbyId invalide" });
			return;
		}
		if (recipientId === userId) {
			res.status(400).json({ message: "Impossible de s'inviter soi-même" });
			return;
		}
		const result = await createInvite(userId, recipientId, steamLobbyId);
		if (!result.ok) {
			res.status(409).json({ message: result.reason });
			return;
		}
		res.status(200).json({ id: result.invite.id, status: result.invite.status });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// GET /api/invites/incoming — pollé côté destinataire pour afficher la popup
// d'invitation (voir MatchmakingOverlay.gd).
const incoming = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const invites = await getIncomingInvites(userId);
		res.status(200).json(invites);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// GET /api/invites/:id/status — pollé côté expéditeur pendant l'attente.
const status = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const inviteId = Number(req.params.id);
		if (!Number.isInteger(inviteId)) {
			res.status(400).json({ message: "Id invalide" });
			return;
		}
		const result = await getInviteStatus(userId, inviteId);
		res.status(200).json({ status: result });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const respond = (accept: boolean) => async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const inviteId = Number(req.params.id);
		if (!Number.isInteger(inviteId)) {
			res.status(400).json({ message: "Id invalide" });
			return;
		}
		const invite = await respondInvite(userId, inviteId, accept);
		if (!invite) {
			res.status(404).json({ message: "Invitation introuvable ou expirée" });
			return;
		}
		res.status(200).json({ status: invite.status, steamLobbyId: Number(invite.steam_lobby_id) });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// POST /api/invites/:id/cancel — bouton "Annuler" côté expéditeur, ou timeout
// local côté client. Toujours 200, jamais d'erreur (voir inviteModel.cancelInvite).
const cancel = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const inviteId = Number(req.params.id);
		if (!Number.isInteger(inviteId)) {
			res.status(400).json({ message: "Id invalide" });
			return;
		}
		await cancelInvite(userId, inviteId);
		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { create, incoming, status, respond, cancel };
