import { Router } from "express";

import { createReport } from "../controller/reportsController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.post("/", rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: "reports:create" }), createReport);

export default router;
