import { Router } from "express";

import {
	joinQueueHandler,
	getQueueStatusHandler,
	reportLobbyHandler,
	cancelQueueHandler,
} from "../controller/matchmakingController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.post(
	"/queue",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "matchmaking:queue-join" }),
	joinQueueHandler,
);
router.get("/queue/:ticketId", getQueueStatusHandler);
router.post("/queue/:ticketId/report-lobby", reportLobbyHandler);
router.delete("/queue/:ticketId", cancelQueueHandler);

export default router;
