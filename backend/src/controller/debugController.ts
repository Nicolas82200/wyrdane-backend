import { Request, Response } from "express";
import db from "../model/db";

// Voir router/debugRouter.ts : diagnostic TEMPORAIRE, à retirer après coup.
const getMatchmakingDebugHandler = async (req: Request, res: Response): Promise<void> => {
	const key = req.header("x-debug-key");
	if (!key || key !== process.env.DEBUG_MATCHMAKING_KEY) {
		res.status(404).end();
		return;
	}

	const [tickets] = await db.query(
		"SELECT ticket_id, user_id, mmr, status, opponent_id, role, steam_lobby_id, match_id IS NOT NULL AS has_match_id, created_at FROM matchmaking_tickets ORDER BY created_at DESC LIMIT 20",
	);
	res.status(200).json({ tickets });
};

export { getMatchmakingDebugHandler };
