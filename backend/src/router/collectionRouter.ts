import { Router } from "express";

import { getCollection, claimStarter } from "../controller/collectionController";

const router = Router();

router.get("/", getCollection);
router.post("/claim-starter", claimStarter);

export default router;
