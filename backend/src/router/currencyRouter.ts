import { Router } from "express";

import {
	getMyBalance,
	claimStarterBonusHandler,
	claimFirstLoginRewardHandler,
} from "../controller/currencyController";

const router = Router();

router.get("/balance", getMyBalance);
router.post("/claim-starter-bonus", claimStarterBonusHandler);
router.post("/claim-first-login-bonus", claimFirstLoginRewardHandler);

export default router;
