import type { RowDataPacket } from "mysql2";
import db from "./db";

interface SoloStatsRow extends RowDataPacket {
	user_id: number;
	wins: number;
	losses: number;
	win_streak: number;
}

const getStats = async (userId: number): Promise<SoloStatsRow> => {
	await db.query(
		"INSERT INTO solo_stats (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = user_id",
		[userId],
	);
	const [rows] = await db.query<SoloStatsRow[]>(
		"SELECT user_id, wins, losses, win_streak FROM solo_stats WHERE user_id = ?",
		[userId],
	);
	return rows[0];
};

// Incrémente wins/losses et met à jour win_streak (victoires consécutives
// vs IA) : +1 sur une victoire, remise à 0 sur une défaite — que la ligne
// existe déjà ou soit créée à l'instant (VALUES(losses) vaut 1 sur une
// défaite dans les deux cas). Renvoie le nouveau win_streak, utilisé par
// rewardsController.reportSoloMatch pour calculer la récompense en or.
const incrementResult = async (userId: number, won: boolean): Promise<number> => {
	await db.query(
		`INSERT INTO solo_stats (user_id, wins, losses, win_streak) VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE wins = wins + VALUES(wins), losses = losses + VALUES(losses),
		 win_streak = IF(VALUES(losses) > 0, 0, win_streak + 1)`,
		[userId, won ? 1 : 0, won ? 0 : 1, won ? 1 : 0],
	);
	const [rows] = await db.query<(RowDataPacket & { win_streak: number })[]>(
		"SELECT win_streak FROM solo_stats WHERE user_id = ?",
		[userId],
	);
	return rows[0]?.win_streak ?? 0;
};

export { getStats, incrementResult };
