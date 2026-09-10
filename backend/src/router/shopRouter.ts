import { Router } from "express";

import {
	getCatalogHandler,
	getMyCosmetics,
	initPurchase,
	finalizePurchase,
} from "../controller/shopController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// init-txn appelle l'API Web Steamworks à chaque appel (steamMicrotxnHelper) :
// sans limite, un compte authentifié pourrait la spammer, gonflant
// purchase_ledger de lignes "pending" et risquant de faire consommer le quota
// (voire déclencher un throttling) de STEAM_WEB_API_KEY, partagée par tous
// les joueurs.
const txnLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, name: "shop:txn" });

router.get("/catalog", getCatalogHandler);
router.get("/cosmetics/me", getMyCosmetics);
router.post("/init-txn", txnLimit, initPurchase);
router.post("/finalize-txn", txnLimit, finalizePurchase);

export default router;
