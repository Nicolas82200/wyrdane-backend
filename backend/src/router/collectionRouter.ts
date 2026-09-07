import { Router } from "express";

import { getCollection, claimStarter, buyCard } from "../controller/collectionController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.get("/", getCollection);
router.post(
	"/claim-starter",
	rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: "collection:claim-starter" }),
	claimStarter,
);
router.post(
	"/buy-card",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 60, name: "collection:buy-card" }),
	buyCard,
);

export default router;
