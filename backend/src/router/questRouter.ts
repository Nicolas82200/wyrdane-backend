import { Router } from "express";

import { getMyDailyQuests, claimMyQuest } from "../controller/questController";
import { getMyWeeklyQuests, claimMyWeeklyQuest } from "../controller/weeklyQuestController";
import { getMyMonthlyQuests, claimMyMonthlyQuest } from "../controller/monthlyQuestController";
import { getMyUniqueQuests, claimMyUniqueQuest } from "../controller/uniqueQuestController";
import { getMyOnboardingQuests, claimMyOnboardingQuest } from "../controller/onboardingQuestController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

const claimLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "quests:claim" });

router.get("/daily", getMyDailyQuests);
router.get("/weekly", getMyWeeklyQuests);
router.post("/weekly/:id/claim", claimLimit, claimMyWeeklyQuest);
router.get("/monthly", getMyMonthlyQuests);
router.post("/monthly/:id/claim", claimLimit, claimMyMonthlyQuest);
router.get("/unique", getMyUniqueQuests);
router.post("/unique/:id/claim", claimLimit, claimMyUniqueQuest);
router.get("/onboarding", getMyOnboardingQuests);
router.post("/onboarding/:id/claim", claimLimit, claimMyOnboardingQuest);
router.post("/:id/claim", claimLimit, claimMyQuest);

export default router;
