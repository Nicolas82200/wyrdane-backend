import { Router } from "express";

import { reportSoloMatch } from "../controller/rewardsController";

const router = Router();

router.post("/solo-match", reportSoloMatch);

export default router;
