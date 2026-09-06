import { Router } from "express";
import authorization from "../middleware/auth";
import requireCsrfHeader from "../middleware/csrf";
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
import matchmakingRouter from "./matchmakingRouter";
import packRouter from "./packRouter";
import profileRouter from "./profileRouter";
import questRouter from "./questRouter";
import rankedRouter from "./rankedRouter";
import referralRouter from "./referralRouter";
import reportsRouter from "./reportsRouter";
import rewardsRouter from "./rewardsRouter";
import shopRouter from "./shopRouter";
import userRouter from "./userRouter";

const router = Router();

// requireCsrfHeader après authorization sur chaque routeur authentifié par
// cookie (voir middleware/csrf.ts) : /auth (login, pas encore de session),
// /contact et /analytics (pas de cookie de session, pas de CORS credentials à
// détourner) restent volontairement hors de sa portée.
router.use("/users", authorization, requireCsrfHeader, userRouter);
router.use("/auth", authRouter);

router.use("/admin", authorization, requireCsrfHeader, requireAdmin, adminRouter);
router.use("/analytics", analyticsRouter);
router.use("/cards", authorization, requireCsrfHeader, cardRouter);
router.use("/collection", authorization, requireCsrfHeader, collectionRouter);
router.use("/contact", contactRouter);
router.use("/currency", authorization, requireCsrfHeader, currencyRouter);
router.use("/decks", authorization, requireCsrfHeader, deckRouter);
router.use("/login-reward", authorization, requireCsrfHeader, loginRewardRouter);
router.use("/matchmaking", authorization, requireCsrfHeader, matchmakingRouter);
router.use("/packs", authorization, requireCsrfHeader, packRouter);
router.use("/profile", authorization, requireCsrfHeader, profileRouter);
router.use("/quests", authorization, requireCsrfHeader, questRouter);
router.use("/ranked", authorization, requireCsrfHeader, rankedRouter);
router.use("/referral", authorization, requireCsrfHeader, referralRouter);
router.use("/reports", authorization, requireCsrfHeader, reportsRouter);
router.use("/rewards", authorization, requireCsrfHeader, rewardsRouter);
router.use("/shop", authorization, requireCsrfHeader, shopRouter);

export default router;
