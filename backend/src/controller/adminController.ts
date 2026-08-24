import { Request, Response } from "express";

import { getStats, setWishlistCount } from "../model/analyticsModel";

// Ping simple pour que le site sache s'il doit afficher le lien vers le
// dashboard : n'est atteignable qu'après authorization + requireAdmin, donc
// répondre 200 ici signifie déjà "cet utilisateur est admin".
const me = (req: Request, res: Response): void => {
	res.status(200).json({ isAdmin: true });
};

const getAdminStats = async (req: Request, res: Response): Promise<void> => {
	try {
		const stats = await getStats();
		res.status(200).json(stats);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Le nombre de wishlists Steam n'est pas exposé par une API Steamworks
// publique (visible seulement dans le dashboard partenaire) : saisie
// manuelle ici, reportée par l'admin depuis ce même dashboard.
const updateWishlistCount = async (req: Request, res: Response): Promise<void> => {
	try {
		const { count } = req.body as { count?: number };
		if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
			res.status(400).json({ message: "Invalid count" });
			return;
		}

		await setWishlistCount(Math.round(count));
		res.status(200).json({ count: Math.round(count) });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { me, getAdminStats, updateWishlistCount };
