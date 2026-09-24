import { Request, Response } from "express";

import {
	searchUsers,
	resolveSteamIds,
	sendFriendRequest,
	acceptFriendRequest,
	deleteFriendship,
	getFriends,
	getIncomingRequests,
} from "../model/friendModel";
import { getUserId } from "../helper/requestUser";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 50;
// Même borne que friendModel.MAX_STEAM_IDS : rejeter ici évite d'aller
// jusqu'au modèle pour un payload déjà aberrant.
const MAX_STEAM_IDS = 200;

// GET /api/friends/search?q= — barre de recherche "ajouter un ami" (voir
// FriendsPanel.gd). Borné à 2 caractères minimum pour éviter de renvoyer une
// bonne partie de la base sur une requête trop courte.
const search = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const query = String(req.query.q ?? "").trim().slice(0, MAX_QUERY_LENGTH);
		if (query.length < MIN_QUERY_LENGTH) {
			res.status(200).json([]);
			return;
		}
		const results = await searchUsers(query, userId);
		res.status(200).json(results);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// POST /api/friends/resolve-steam-ids — reçoit les SteamID64 des amis Steam
// locaux du joueur (voir SteamService.get_steam_friend_ids côté client) et
// renvoie ceux qui ont un compte Wyrdane, pour peupler la section "Amis
// Steam" de FriendsPanel.gd sans recherche manuelle par pseudo.
const resolveSteamFriends = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const steamIds = (req.body as { steamIds?: unknown }).steamIds;
		if (!Array.isArray(steamIds) || steamIds.length === 0) {
			res.status(200).json([]);
			return;
		}
		if (steamIds.length > MAX_STEAM_IDS || !steamIds.every((id) => typeof id === "string")) {
			res.status(400).json({ message: "steamIds invalide" });
			return;
		}
		const results = await resolveSteamIds(steamIds, userId);
		res.status(200).json(results);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const list = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const friends = await getFriends(userId);
		res.status(200).json(friends);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const listIncomingRequests = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const requests = await getIncomingRequests(userId);
		res.status(200).json(requests);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const sendRequest = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const targetUserId = Number((req.body as { userId?: number }).userId);
		if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
			res.status(400).json({ message: "userId invalide" });
			return;
		}
		if (targetUserId === userId) {
			res.status(400).json({ message: "Impossible de s'ajouter soi-même" });
			return;
		}
		const result = await sendFriendRequest(userId, targetUserId);
		res.status(200).json({ status: result });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const accept = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const friendshipId = Number(req.params.id);
		if (!Number.isInteger(friendshipId)) {
			res.status(400).json({ message: "Id invalide" });
			return;
		}
		const accepted = await acceptFriendRequest(friendshipId, userId);
		if (!accepted) {
			res.status(404).json({ message: "Demande introuvable" });
			return;
		}
		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Sert à la fois à refuser une demande reçue, annuler une demande envoyée, et
// supprimer un ami existant — voir friendModel.deleteFriendship.
const remove = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const friendshipId = Number(req.params.id);
		if (!Number.isInteger(friendshipId)) {
			res.status(400).json({ message: "Id invalide" });
			return;
		}
		const removed = await deleteFriendship(friendshipId, userId);
		if (!removed) {
			res.status(404).json({ message: "Relation introuvable" });
			return;
		}
		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { search, resolveSteamFriends, list, listIncomingRequests, sendRequest, accept, remove };
