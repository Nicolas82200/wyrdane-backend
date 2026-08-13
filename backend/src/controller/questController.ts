import { Request, Response } from "express";

import {
	getDailyQuests,
	claimQuest,
	QuestNotFoundError,
	QuestNotCompletedError,
	QuestAlreadyClaimedError,
} from "../model/questModel";
import { getUserId } from "../helper/requestUser";

const getMyDailyQuests = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const data = await getDailyQuests(userId);
		res.status(200).json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimMyQuest = async (req: Request, res: Response): Promise<void> => {
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

		const result = await claimQuest(userId, questId);
		res.status(200).json(result);
	} catch (error) {
		if (error instanceof QuestNotFoundError) {
			res.status(404).json({ message: error.message });
			return;
		}
		if (error instanceof QuestAlreadyClaimedError || error instanceof QuestNotCompletedError) {
			res.status(400).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyDailyQuests, claimMyQuest };
