import { Router } from "express";

import {
	reportMatch,
	getMyStats,
	getMatchHistoryHandler,
	getLeaderboardHandler,
	getMyLeaderboardPositionHandler,
	getLeaderboardAroundMeHandler,
	searchLeaderboardHandler,
} from "../controller/rankedController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.get("/me", getMyStats);
router.get("/matches/history", getMatchHistoryHandler);
// Ordre important : routes littérales avant "/leaderboard" pour ne jamais
// être capturées par un futur param dynamique - pas de conflit actuel mais
// garde l'habitude.
router.get("/leaderboard/me", getMyLeaderboardPositionHandler);
router.get("/leaderboard/around-me", getLeaderboardAroundMeHandler);
router.get("/leaderboard/search", searchLeaderboardHandler);
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
