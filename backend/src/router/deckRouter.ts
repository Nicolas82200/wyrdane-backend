import { Router } from "express";

import {
	getUserDecks,
	getOne,
	save,
	remove,
} from "../controller/deckController";

const router = Router();

router.get("/", getUserDecks);
router.get("/:id", getOne);
router.post("/", save);
router.put("/:id", save);
router.delete("/:id", remove);

export default router;
