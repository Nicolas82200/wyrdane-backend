import { Router } from "express";

import { search, list, listIncomingRequests, sendRequest, accept, remove } from "../controller/friendController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Ordre important : routes littérales avant "/:id" pour ne jamais être
// capturées par le paramètre dynamique (même habitude que rankedRouter).
router.get("/search", search);
router.get("/requests", listIncomingRequests);
router.post(
	"/requests",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "friends:requests" }),
	sendRequest,
);
router.post("/requests/:id/accept", accept);
router.get("/", list);
router.delete("/:id", remove);

export default router;
