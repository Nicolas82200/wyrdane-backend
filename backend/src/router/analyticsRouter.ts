import { Router } from "express";

import { trackPageview } from "../controller/analyticsController";

const router = Router();

router.post("/pageview", trackPageview);

export default router;
