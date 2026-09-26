import { Request, Response } from "express";

import { getLevel, getRewardCatalog, getUserRewards, claimRewards } from "../model/levelModel";
import { getUserId } from "../helper/requestUser";

const getMyLevelRewards = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { level } = await getLevel(userId);
		const catalog = getRewardCatalog(level);
		const rewards = await getUserRewards(userId);
		res.status(200).json({ level, catalog, rewards });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimMyLevelRewards = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const rawBody = req.body as { levels?: unknown };
		if (!Array.isArray(rawBody.levels) || rawBody.levels.length === 0) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}
		const levels = rawBody.levels.filter((level): level is number => Number.isInteger(level));

		const claimed = await claimRewards(userId, levels);
		res.status(200).json({ claimed });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyLevelRewards, claimMyLevelRewards };
