import { Router } from "express";

import {
	getMyBalance,
	claimStarterBonusHandler,
	claimFirstLoginRewardHandler,
} from "../controller/currencyController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

const claimLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: "currency:claim" });

router.get("/balance", getMyBalance);
router.post("/claim-starter-bonus", claimLimit, claimStarterBonusHandler);
router.post("/claim-first-login-bonus", claimLimit, claimFirstLoginRewardHandler);

export default router;
