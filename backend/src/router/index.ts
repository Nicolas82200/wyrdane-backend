import { Router } from "express";
import authorization from "../middleware/auth";
import authRouter from "./authRouter";
import cardRouter from "./cardRouter";
import collectionRouter from "./collectionRouter";
import deckRouter from "./deckRouter";
import rankedRouter from "./rankedRouter";
import userRouter from "./userRouter";

const router = Router();

router.use("/users", authorization, userRouter);
router.use("/auth", authRouter);

router.use("/cards", authorization, cardRouter);
router.use("/collection", authorization, collectionRouter);
router.use("/decks", authorization, deckRouter);
router.use("/ranked", authorization, rankedRouter);

export default router;
