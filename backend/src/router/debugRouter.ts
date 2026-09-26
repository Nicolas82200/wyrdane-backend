import { Router } from "express";

import { getMatchmakingDebugHandler } from "../controller/debugController";

// Route de diagnostic TEMPORAIRE (matchmaking classé qui ne s'apparie pas,
// 2026-09-21) — protégée par une clé statique (header x-debug-key, voir
// DEBUG_MATCHMAKING_KEY dans .env), pas par le cookie de session habituel :
// permet une lecture seule sans authentification Steam. À supprimer une fois
// le diagnostic terminé (ce fichier, debugController.ts, l'entrée dans
// router/index.ts, et la variable d'env).
const router = Router();

router.get("/matchmaking", getMatchmakingDebugHandler);

export default router;
