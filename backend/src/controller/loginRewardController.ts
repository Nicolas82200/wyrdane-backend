import { Request, Response } from "express";

import { getStatus, claim, AlreadyClaimedTodayError } from "../model/loginRewardModel";
import { getUserId } from "../helper/requestUser";

const getMyLoginRewardStatus = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const status = await getStatus(userId);
		res.status(200).json(status);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimMyLoginReward = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const result = await claim(userId);
		res.status(200).json(result);
	} catch (error) {
		if (error instanceof AlreadyClaimedTodayError) {
			res.status(400).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyLoginRewardStatus, claimMyLoginReward };
