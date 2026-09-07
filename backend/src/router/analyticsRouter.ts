import { Router } from "express";

import { trackPageview } from "../controller/analyticsController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Route publique (pas d'authorization) : la clé par défaut retombe sur l'IP.
router.post(
	"/pageview",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 120, name: "analytics:pageview" }),
	trackPageview,
);

export default router;
