import { Request, Response } from "express";

import {
	getUniqueQuests,
	claimUniqueQuest,
	UniqueQuestNotFoundError,
	UniqueQuestNotCompletedError,
	UniqueQuestAlreadyClaimedError,
} from "../model/uniqueQuestModel";
import { getUserId } from "../helper/requestUser";

const getMyUniqueQuests = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const data = await getUniqueQuests(userId);
		res.status(200).json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimMyUniqueQuest = async (req: Request, res: Response): Promise<void> => {
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

		const result = await claimUniqueQuest(userId, questId);
		res.status(200).json(result);
	} catch (error) {
		if (error instanceof UniqueQuestNotFoundError) {
			res.status(404).json({ message: error.message });
			return;
		}
		if (error instanceof UniqueQuestAlreadyClaimedError || error instanceof UniqueQuestNotCompletedError) {
			res.status(400).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyUniqueQuests, claimMyUniqueQuest };
