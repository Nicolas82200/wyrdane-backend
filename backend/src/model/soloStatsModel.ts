import type { RowDataPacket } from "mysql2";
import db from "./db";

interface SoloStatsRow extends RowDataPacket {
	user_id: number;
	wins: number;
	losses: number;
}

const getStats = async (userId: number): Promise<SoloStatsRow> => {
	await db.query(
		"INSERT INTO solo_stats (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = user_id",
		[userId],
	);
	const [rows] = await db.query<SoloStatsRow[]>(
		"SELECT user_id, wins, losses FROM solo_stats WHERE user_id = ?",
		[userId],
	);
	return rows[0];
};

// Appelé indépendamment du plafond quotidien de récompense (voir
// rewardsController.reportSoloMatch) : les stats affichées au profil
// comptent toutes les parties, seule la monnaie gagnée est plafonnée.
const incrementResult = async (userId: number, won: boolean): Promise<void> => {
	await db.query(
		`INSERT INTO solo_stats (user_id, wins, losses) VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE wins = wins + VALUES(wins), losses = losses + VALUES(losses)`,
		[userId, won ? 1 : 0, won ? 0 : 1],
	);
};

export { getStats, incrementResult };
