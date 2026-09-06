import { Router } from "express";

import {
	joinQueueHandler,
	getQueueStatusHandler,
	reportLobbyHandler,
	cancelQueueHandler,
} from "../controller/matchmakingController";

const router = Router();

router.post("/queue", joinQueueHandler);
router.get("/queue/:ticketId", getQueueStatusHandler);
router.post("/queue/:ticketId/report-lobby", reportLobbyHandler);
router.delete("/queue/:ticketId", cancelQueueHandler);

export default router;
