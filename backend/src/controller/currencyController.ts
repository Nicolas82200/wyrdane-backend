import { Request, Response } from "express";

import { getBalance, getFreePacksByRace, claimStarterBonus, claimFirstLoginReward } from "../model/currencyModel";
import { getUserId } from "../helper/requestUser";

const getMyBalance = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const [balance, freePacksByRace] = await Promise.all([getBalance(userId), getFreePacksByRace(userId)]);
		// free_packs reste la somme : c'est elle que lit le client qui n'a pas
		// besoin du détail (pastille du menu principal).
		const freePacks = Object.values(freePacksByRace).reduce((sum, quantity) => sum + quantity, 0);
		res.status(200).json({ balance, free_packs: freePacks, free_packs_by_race: freePacksByRace });
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

const claimFirstLoginRewardHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { credited, balance, amount } = await claimFirstLoginReward(userId);
		res.status(200).json({ credited, balance, amount });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyBalance, claimStarterBonusHandler, claimFirstLoginRewardHandler };
