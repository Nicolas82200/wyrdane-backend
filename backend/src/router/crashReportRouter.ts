import { Router } from "express";

import { submitCrashReport } from "../controller/crashReportController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Route publique (pas d'authorization) : un crash peut survenir avant tout
// login réussi côté client, et la popup d'envoi ne doit pas dépendre d'une
// session encore valide. La clé de rate-limit retombe donc sur l'IP.
router.post("/", rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: "crash-report:submit" }), submitCrashReport);

export default router;
