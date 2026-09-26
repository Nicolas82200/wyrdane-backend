import { Request, Response } from "express";

import {
	getOnboardingQuests,
	claimOnboardingQuest,
	OnboardingQuestNotFoundError,
	OnboardingQuestNotCompletedError,
	OnboardingQuestAlreadyClaimedError,
} from "../model/onboardingQuestModel";
import { getLevel } from "../model/levelModel";
import { getUserId } from "../helper/requestUser";

const getMyOnboardingQuests = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { level } = await getLevel(userId);
		const data = await getOnboardingQuests(userId, level);
		res.status(200).json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const claimMyOnboardingQuest = async (req: Request, res: Response): Promise<void> => {
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

		const result = await claimOnboardingQuest(userId, questId);
		res.status(200).json(result);
	} catch (error) {
		if (error instanceof OnboardingQuestNotFoundError) {
			res.status(404).json({ message: error.message });
			return;
		}
		if (error instanceof OnboardingQuestAlreadyClaimedError || error instanceof OnboardingQuestNotCompletedError) {
			res.status(400).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyOnboardingQuests, claimMyOnboardingQuest };
