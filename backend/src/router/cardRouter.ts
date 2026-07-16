import { Router } from "express";

import { getAll } from "../controller/cardController";

const router = Router();

router.get("/", getAll);

export default router;
