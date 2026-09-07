import { Router } from "express";

import { openPackHandler, openFreePackHandler, openOwnedPackHandler } from "../controller/packController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

const openLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "packs:open" });

router.post("/open", openLimit, openPackHandler);
router.post("/open-free", openLimit, openFreePackHandler);
router.post("/open-owned", openLimit, openOwnedPackHandler);

export default router;
