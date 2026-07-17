import { Router } from "express";

import {
	steamLogin,
	steamOpenIdRedirect,
	steamOpenIdCallback,
	logout,
	authVerif,
} from "../controller/authController";
import authorization from "../middleware/auth";

const router = Router();

router.post("/steam", steamLogin);
router.get("/steam/redirect", steamOpenIdRedirect);
router.get("/steam/callback", steamOpenIdCallback);

router.get("/logout", logout);

router.get("/authVerif", authorization, authVerif);

export default router;
