import { Request, Response } from "express";

import { findOne } from "../model/userModel";
import { getUserId } from "../helper/requestUser";

const getOne = async (req: Request, res: Response): Promise<void> => {
	const id = Number(req.params.id);
	if (Number.isNaN(id)) {
		res.status(400).json({ message: "Invalid id" });
		return;
	}

	// Un joueur ne peut lire que sa propre fiche : sans ce contrôle, n'importe
	// quel compte authentifié pouvait énumérer /api/users/1, /2, /3... et lire
	// username/created_at de n'importe quel autre joueur (IDOR).
	if (id !== getUserId(req)) {
		res.status(404).json({ message: "User not found" });
		return;
	}

	try {
		const [user] = await findOne(id);
		if (!user) {
			res.status(404).json({ message: "User not found" });
			return;
		}
		res.status(200).json(user);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getOne };
