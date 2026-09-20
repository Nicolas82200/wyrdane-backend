import { Router } from "express";

import { getMyLevelRewards, claimMyLevelRewards } from "../controller/levelController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.get("/rewards", getMyLevelRewards);
router.post(
	"/rewards/claim",
	rateLimit({ windowMs: 60 * 1000, max: 20, name: "level:rewards-claim" }),
	claimMyLevelRewards,
);

export default router;
