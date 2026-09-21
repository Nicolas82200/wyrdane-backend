import { Request, Response } from "express";

import {
	getMonthlyQuests,
	claimMonthlyQuest,
	MonthlyQuestNotFoundError,
	MonthlyQuestNotCompletedError,
	MonthlyQuestAlreadyClaimedError,
} from "../model/monthlyQuestModel";
import { getUserId } from "../helper/requestUser";

const getMyMonthlyQuests = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const data = await getMonthlyQuests(userId);
		res.status(200).json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimMyMonthlyQuest = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const questId = Number(req.params.id);
		if (!Number.isInteger(questId)) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		const result = await claimMonthlyQuest(userId, questId);
		res.status(200).json(result);
	} catch (error) {
		if (error instanceof MonthlyQuestNotFoundError) {
			res.status(404).json({ message: error.message });
			return;
		}
		if (error instanceof MonthlyQuestAlreadyClaimedError || error instanceof MonthlyQuestNotCompletedError) {
			res.status(400).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyMonthlyQuests, claimMyMonthlyQuest };
