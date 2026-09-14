import { Router } from "express";

import {
	steamLogin,
	steamOpenIdRedirect,
	steamOpenIdCallback,
	logout,
	authVerif,
} from "../controller/authController";
import authorization from "../middleware/auth";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Par IP (pas encore de session avant login) : chaque appel déclenche 1-2
// requêtes réseau sortantes vers Steam + une écriture DB potentielle, seule
// route d'authentification du projet à ne pas avoir cette digue jusqu'ici.
const authLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, name: "auth:steam" });

router.post("/steam", authLimit, steamLogin);
router.get("/steam/redirect", authLimit, steamOpenIdRedirect);
router.get("/steam/callback", authLimit, steamOpenIdCallback);

router.get("/logout", logout);

router.get("/authVerif", authorization, authVerif);

export default router;
