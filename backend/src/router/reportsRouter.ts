import { Router } from "express";

import { createReport } from "../controller/reportsController";

const router = Router();

router.post("/", createReport);

export default router;
