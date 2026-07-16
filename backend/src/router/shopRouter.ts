import { Router } from "express";

import {
	getCatalogHandler,
	getMyCosmetics,
	initPurchase,
	finalizePurchase,
} from "../controller/shopController";

const router = Router();

router.get("/catalog", getCatalogHandler);
router.get("/cosmetics/me", getMyCosmetics);
router.post("/init-txn", initPurchase);
router.post("/finalize-txn", finalizePurchase);

export default router;
