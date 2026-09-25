import { Router } from "express";

import { create, incoming, status, respond, cancel } from "../controller/inviteController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Ordre important : routes littérales avant "/:id" — même habitude que
// friendRouter/rankedRouter.
router.get("/incoming", incoming);
router.post(
	"/",
	rateLimit({ windowMs: 10 * 60 * 1000, max: 30, name: "invites:create" }),
	create,
);
router.get("/:id/status", status);
router.post("/:id/accept", respond(true));
router.post("/:id/decline", respond(false));
router.post("/:id/cancel", cancel);

export default router;
