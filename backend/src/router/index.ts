import { Router } from "express";
import authorization from "../middleware/auth";
import authRouter from "./authRouter";
import cardRouter from "./cardRouter";
import collectionRouter from "./collectionRouter";
import currencyRouter from "./currencyRouter";
import deckRouter from "./deckRouter";
import packRouter from "./packRouter";
import rankedRouter from "./rankedRouter";
import rewardsRouter from "./rewardsRouter";
import shopRouter from "./shopRouter";
import userRouter from "./userRouter";

const router = Router();

router.use("/users", authorization, userRouter);
router.use("/auth", authRouter);

router.use("/cards", authorization, cardRouter);
router.use("/collection", authorization, collectionRouter);
router.use("/currency", authorization, currencyRouter);
router.use("/decks", authorization, deckRouter);
router.use("/packs", authorization, packRouter);
router.use("/ranked", authorization, rankedRouter);
router.use("/rewards", authorization, rewardsRouter);
router.use("/shop", authorization, shopRouter);

export default router;
