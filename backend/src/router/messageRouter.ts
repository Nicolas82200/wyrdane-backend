import { Router } from "express";

import { send, conversation, conversations, markRead, unreadTotal } from "../controller/messageController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

router.get("/conversations", conversations);
router.get("/unread-total", unreadTotal);
router.get("/:friendId", conversation);
router.post("/:friendId/read", markRead);
// Polling client (voir ChatWindow.gd) : le rythme de lecture reste par ailleurs
// borné par l'intervalle de poll côté client (quelques secondes), cette
// limite protège surtout contre un envoi en rafale (spam de messages).
router.post(
	"/",
	rateLimit({ windowMs: 60 * 1000, max: 30, name: "messages:send" }),
	send,
);

export default router;
