import { Router } from "express";

import { getMyBalance } from "../controller/currencyController";

const router = Router();

router.get("/balance", getMyBalance);

export default router;
