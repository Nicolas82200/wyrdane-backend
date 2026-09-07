import { Request, Response } from "express";

import {
	getWeeklyQuests,
	claimWeeklyQuest,
	WeeklyQuestNotFoundError,
	WeeklyQuestNotCompletedError,
	WeeklyQuestAlreadyClaimedError,
} from "../model/weeklyQuestModel";
import { getUserId } from "../helper/requestUser";

const getMyWeeklyQuests = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const data = await getWeeklyQuests(userId);
		res.status(200).json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimMyWeeklyQuest = async (req: Request, res: Response): Promise<void> => {
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

		const result = await claimWeeklyQuest(userId, questId);
		res.status(200).json(result);
	} catch (error) {
		if (error instanceof WeeklyQuestNotFoundError) {
			res.status(404).json({ message: error.message });
			return;
		}
		if (error instanceof WeeklyQuestAlreadyClaimedError || error instanceof WeeklyQuestNotCompletedError) {
			res.status(400).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyWeeklyQuests, claimMyWeeklyQuest };
