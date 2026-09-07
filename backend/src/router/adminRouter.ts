import { Router } from "express";

import { me, getAdminStats, updateWishlistCount } from "../controller/adminController";

const router = Router();

router.get("/me", me);
router.get("/stats", getAdminStats);
router.put("/wishlist", updateWishlistCount);

export default router;
