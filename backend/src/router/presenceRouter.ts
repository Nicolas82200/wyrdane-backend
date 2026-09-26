import { Router } from "express";

import { sendHeartbeat } from "../controller/presenceController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.post(
	"/heartbeat",
	rateLimit({ windowMs: 60 * 1000, max: 6, name: "presence:heartbeat" }),
	sendHeartbeat,
);

export default router;
