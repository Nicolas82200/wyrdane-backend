import { Router } from "express";
import authorization from "../middleware/auth";
import requireAdmin from "../middleware/requireAdmin";
import adminRouter from "./adminRouter";
import analyticsRouter from "./analyticsRouter";
import authRouter from "./authRouter";
import cardRouter from "./cardRouter";
import collectionRouter from "./collectionRouter";
import contactRouter from "./contactRouter";
import currencyRouter from "./currencyRouter";
import deckRouter from "./deckRouter";
import loginRewardRouter from "./loginRewardRouter";
import packRouter from "./packRouter";
import profileRouter from "./profileRouter";
import questRouter from "./questRouter";
import rankedRouter from "./rankedRouter";
import rewardsRouter from "./rewardsRouter";
import shopRouter from "./shopRouter";
import userRouter from "./userRouter";

const router = Router();

router.use("/users", authorization, userRouter);
router.use("/auth", authRouter);

router.use("/admin", authorization, requireAdmin, adminRouter);
router.use("/analytics", analyticsRouter);
router.use("/cards", authorization, cardRouter);
router.use("/collection", authorization, collectionRouter);
router.use("/contact", contactRouter);
router.use("/currency", authorization, currencyRouter);
router.use("/decks", authorization, deckRouter);
router.use("/login-reward", authorization, loginRewardRouter);
router.use("/packs", authorization, packRouter);
router.use("/profile", authorization, profileRouter);
router.use("/quests", authorization, questRouter);
router.use("/ranked", authorization, rankedRouter);
router.use("/rewards", authorization, rewardsRouter);
router.use("/shop", authorization, shopRouter);

export default router;
