import { Router } from "express";

import { getMyLoginRewardStatus, claimMyLoginReward } from "../controller/loginRewardController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.get("/status", getMyLoginRewardStatus);
router.post(
	"/claim",
	rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: "login-reward:claim" }),
	claimMyLoginReward,
);

export default router;
