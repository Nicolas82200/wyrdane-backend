import { Router } from "express";

import { getMyDailyQuests, claimMyQuest } from "../controller/questController";
import { getMyWeeklyQuests, claimMyWeeklyQuest } from "../controller/weeklyQuestController";
import { getMyUniqueQuests, claimMyUniqueQuest } from "../controller/uniqueQuestController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

const claimLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "quests:claim" });

router.get("/daily", getMyDailyQuests);
router.get("/weekly", getMyWeeklyQuests);
router.post("/weekly/:id/claim", claimLimit, claimMyWeeklyQuest);
router.get("/unique", getMyUniqueQuests);
router.post("/unique/:id/claim", claimLimit, claimMyUniqueQuest);
router.post("/:id/claim", claimLimit, claimMyQuest);

export default router;
