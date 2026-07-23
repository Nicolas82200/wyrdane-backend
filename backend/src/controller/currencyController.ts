import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import { getBalance, claimStarterBonus } from "../model/currencyModel";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

const getMyBalance = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const balance = await getBalance(userId);
		res.status(200).json({ balance });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimStarterBonusHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { credited, balance } = await claimStarterBonus(userId);
		res.status(200).json({ credited, balance });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyBalance, claimStarterBonusHandler };
