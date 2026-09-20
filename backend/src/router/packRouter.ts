import { Router } from "express";

import { openPackHandler, openFreePackHandler, openOwnedPackHandler, buyPacksHandler } from "../controller/packController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Un compteur par route : les trois partageaient auparavant le même seau
// ("packs:open"), donc ouvrir des packs payants épuisait aussi le quota des
// packs gratuits/possédés du même joueur (et inversement).
router.post("/open", rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "packs:open" }), openPackHandler);
router.post(
	"/open-free",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "packs:open-free" }),
	openFreePackHandler,
);
router.post(
	"/open-owned",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "packs:open-owned" }),
	openOwnedPackHandler,
);
router.post("/buy", rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "packs:buy" }), buyPacksHandler);

export default router;
