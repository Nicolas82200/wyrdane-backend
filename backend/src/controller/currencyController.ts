import { Request, Response } from "express";

import { getBalance, claimStarterBonus } from "../model/currencyModel";
import { getUserId } from "../helper/requestUser";

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
