import { Router } from "express";

import { getMyProfile } from "../controller/profileController";

const router = Router();

router.get("/", getMyProfile);

export default router;
