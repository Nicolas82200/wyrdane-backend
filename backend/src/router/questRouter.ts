import { Router } from "express";

import { getMyDailyQuests, claimMyQuest } from "../controller/questController";

const router = Router();

router.get("/daily", getMyDailyQuests);
router.post("/:id/claim", claimMyQuest);

export default router;
