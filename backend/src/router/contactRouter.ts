import { Router } from "express";

import { submitContact } from "../controller/contactController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Route publique (pas d'authorization) : la clé par défaut retombe sur l'IP.
router.post("/", rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: "contact:submit" }), submitContact);

export default router;
