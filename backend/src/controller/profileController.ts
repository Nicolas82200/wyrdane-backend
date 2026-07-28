import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import { getProfile } from "../model/profileModel";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

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

export { getMyProfile };
