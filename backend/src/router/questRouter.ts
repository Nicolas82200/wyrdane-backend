import { Router } from "express";

import { getMyDailyQuests, claimMyQuest } from "../controller/questController";
import { getMyWeeklyQuests, claimMyWeeklyQuest } from "../controller/weeklyQuestController";

const router = Router();

router.get("/daily", getMyDailyQuests);
router.get("/weekly", getMyWeeklyQuests);
router.post("/weekly/:id/claim", claimMyWeeklyQuest);
router.post("/:id/claim", claimMyQuest);

export default router;
