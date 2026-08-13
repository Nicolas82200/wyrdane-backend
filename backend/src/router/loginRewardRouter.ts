import { Router } from "express";

import { getMyLoginRewardStatus, claimMyLoginReward } from "../controller/loginRewardController";

const router = Router();

router.get("/status", getMyLoginRewardStatus);
router.post("/claim", claimMyLoginReward);

export default router;
