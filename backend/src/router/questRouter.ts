import { Router } from "express";

import { getMyDailyQuests, claimMyQuest } from "../controller/questController";
import { getMyWeeklyQuests, claimMyWeeklyQuest } from "../controller/weeklyQuestController";
import { getMyUniqueQuests, claimMyUniqueQuest } from "../controller/uniqueQuestController";

const router = Router();

router.get("/daily", getMyDailyQuests);
router.get("/weekly", getMyWeeklyQuests);
router.post("/weekly/:id/claim", claimMyWeeklyQuest);
router.get("/unique", getMyUniqueQuests);
router.post("/unique/:id/claim", claimMyUniqueQuest);
router.post("/:id/claim", claimMyQuest);

export default router;
