import { Router } from "express";

import { getMyProfile, getFriendProfile } from "../controller/profileController";

const router = Router();

router.get("/", getMyProfile);
router.get("/:userId", getFriendProfile);

export default router;
