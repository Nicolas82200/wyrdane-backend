import { Router } from "express";

import { reportSoloMatch } from "../controller/rewardsController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Aucune preuve serveur qu'un match solo/IA a réellement eu lieu (voir
// controller) : le rate-limiting est la seule digue contre un script qui
// boucle cet appel pour farmer quêtes/stats. Une vraie partie ne peut de
// toute façon pas se terminer plus vite qu'environ une par minute.
router.post(
	"/solo-match",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 15, name: "rewards:solo-match" }),
	reportSoloMatch,
);

export default router;
