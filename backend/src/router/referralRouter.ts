import { Router } from "express";

import { getMyReferralCode, getMyReferralStatus, redeemMyReferralCode } from "../controller/referralController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.get("/code", getMyReferralCode);
router.get("/status", getMyReferralStatus);
router.post(
	"/redeem",
	rateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: "referral:redeem" }),
	redeemMyReferralCode,
);

export default router;
