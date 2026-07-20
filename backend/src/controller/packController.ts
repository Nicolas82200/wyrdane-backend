import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import { openPack, PACK_COST } from "../model/packModel";
import { InsufficientFundsError } from "../model/currencyModel";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

const openPackHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { cards, balance } = await openPack(userId);
		res.status(200).json({ cards, balance });
	} catch (error) {
		if (error instanceof InsufficientFundsError) {
			res.status(400).json({ message: `Solde insuffisant (coût : ${PACK_COST})` });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { openPackHandler };
