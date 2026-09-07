import { Router } from "express";

import {
	reportMatch,
	getMyStats,
	getLeaderboardHandler,
} from "../controller/rankedController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.get("/me", getMyStats);
router.get("/leaderboard", getLeaderboardHandler);
// Un client rappelle légitimement cette route plusieurs fois par match (202
// pending en attendant le rapport du pair, voir MatchResultReporter côté
// client) : fenêtre large pour ne pas gêner les retries normaux, tout en
// bornant un script qui viserait à farmer MMR/or/quêtes via des rapports
// fictifs entre deux comptes colludés.
router.post(
	"/matches/report",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "ranked:matches-report" }),
	reportMatch,
);

export default router;
