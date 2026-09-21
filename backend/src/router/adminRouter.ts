import { Router } from "express";

import { me, getAdminStats, updateWishlistCount, getAdminCardStats } from "../controller/adminController";

const router = Router();

router.get("/me", me);
router.get("/stats", getAdminStats);
router.put("/wishlist", updateWishlistCount);
router.get("/card-stats", getAdminCardStats);

export default router;
