import { Router } from "express";

import { openPackHandler } from "../controller/packController";

const router = Router();

router.post("/open", openPackHandler);

export default router;
