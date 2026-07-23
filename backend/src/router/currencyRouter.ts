import { Router } from "express";

import { getMyBalance, claimStarterBonusHandler } from "../controller/currencyController";

const router = Router();

router.get("/balance", getMyBalance);
router.post("/claim-starter-bonus", claimStarterBonusHandler);

export default router;
