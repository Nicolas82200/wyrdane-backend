import { Request, Response } from "express";

import { getProfile } from "../model/profileModel";
import { findFriendship } from "../model/friendModel";
import { getUserId } from "../helper/requestUser";

// Profil agrégé du joueur connecté (voir GET /api/users/:id pour un profil
// public minimal) : compte de collection, stats solo et ranked (avec rang),
// consommé par le panneau profil du menu principal côté client.
const getMyProfile = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const profile = await getProfile(userId);
		if (!profile) {
			res.status(404).json({ message: "User not found" });
			return;
		}

		res.status(200).json(profile);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Profil d'un AUTRE joueur (bouton "Voir le profil" sur une ligne d'ami côté
// FriendsPanel.gd) — renvoie exactement le même format que getMyProfile pour
// que le client rende les deux avec le même code (ProfilePanel.gd), juste
// avec les données de la cible plutôt que celles de l'appelant. Contrairement
// au leaderboard (public à tout joueur connecté, voir rankedController), ce
// profil expose l'historique de parties de la cible — restreint aux amis
// acceptés plutôt que laissé ouvert à n'importe quel compte authentifié.
const getFriendProfile = async (req: Request, res: Response): Promise<void> => {
	try {
		const viewerId = getUserId(req);
		if (!viewerId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const targetId = Number(req.params.userId);
		if (Number.isNaN(targetId)) {
			res.status(400).json({ message: "Invalid id" });
			return;
		}

		if (targetId !== viewerId) {
			const friendship = await findFriendship(viewerId, targetId);
			if (!friendship || friendship.status !== "accepted") {
				res.status(403).json({ message: "Vous devez être ami avec ce joueur pour voir son profil" });
				return;
			}
		}

		const profile = await getProfile(targetId);
		if (!profile) {
			res.status(404).json({ message: "User not found" });
			return;
		}

		res.status(200).json(profile);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyProfile, getFriendProfile };
