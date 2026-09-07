import { Router } from "express";

import { getMyReferralCode, getMyReferralStatus, redeemMyReferralCode } from "../controller/referralController";

const router = Router();

router.get("/code", getMyReferralCode);
router.get("/status", getMyReferralStatus);
router.post("/redeem", redeemMyReferralCode);

export default router;
