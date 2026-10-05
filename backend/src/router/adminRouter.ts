import { Router } from "express";

import { me, getAdminStats, updateWishlistCount, getAdminCardStats, syncCards } from "../controller/adminController";

const router = Router();

router.get("/me", me);
router.get("/stats", getAdminStats);
router.put("/wishlist", updateWishlistCount);
router.get("/card-stats", getAdminCardStats);
router.post("/sync-cards", syncCards);

export default router;
