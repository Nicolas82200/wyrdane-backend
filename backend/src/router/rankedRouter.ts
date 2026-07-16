import { Router } from "express";

import {
	reportMatch,
	getMyStats,
	getLeaderboardHandler,
} from "../controller/rankedController";

const router = Router();

router.get("/me", getMyStats);
router.get("/leaderboard", getLeaderboardHandler);
router.post("/matches/report", reportMatch);

export default router;
