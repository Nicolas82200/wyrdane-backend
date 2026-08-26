import { Router } from "express";

import { openPackHandler, openFreePackHandler, openOwnedPackHandler } from "../controller/packController";

const router = Router();

router.post("/open", openPackHandler);
router.post("/open-free", openFreePackHandler);
router.post("/open-owned", openOwnedPackHandler);

export default router;
