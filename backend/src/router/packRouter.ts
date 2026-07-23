import { Router } from "express";

import { openPackHandler, openFreePackHandler } from "../controller/packController";

const router = Router();

router.post("/open", openPackHandler);
router.post("/open-free", openFreePackHandler);

export default router;
