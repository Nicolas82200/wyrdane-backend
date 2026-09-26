import { Request, Response } from "express";

import { heartbeat } from "../model/presenceModel";
import { getUserId } from "../helper/requestUser";

// POST /api/presence/heartbeat — appelé périodiquement par PresenceService.gd
// tant que le jeu tourne et qu'un joueur est authentifié (menu principal ET
// en bataille) — voir friendModel.ONLINE_WINDOW_SECONDS pour la fenêtre de
// tolérance côté lecture.
const sendHeartbeat = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const inGame = Boolean((req.body as { inGame?: boolean }).inGame);
		await heartbeat(userId, inGame);
		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { sendHeartbeat };
