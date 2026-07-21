import { Router } from "express";

import { getCollection, claimStarter, buyCard } from "../controller/collectionController";

const router = Router();

router.get("/", getCollection);
router.post("/claim-starter", claimStarter);
router.post("/buy-card", buyCard);

export default router;
