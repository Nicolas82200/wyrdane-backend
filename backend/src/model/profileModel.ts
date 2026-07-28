import type { RowDataPacket } from "mysql2";
import db from "./db";
import { findOne } from "./userModel";
import { getStats as getRankedStats, CURRENT_SEASON } from "./rankedModel";
import { getStats as getSoloStats } from "./soloStatsModel";

interface ProfileData {
	id: number;
	username: string;
	created_at: string;
	collection_count: number;
	solo: { wins: number; losses: number };
	ranked: { mmr: number; wins: number; losses: number; rank: number };
}

const getCollectionCount = async (userId: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { count: number })[]>(
		"SELECT COALESCE(SUM(quantity), 0) AS count FROM user_cards WHERE user_id = ?",
		[userId],
	);
	return rows[0]?.count ?? 0;
};

// Position dans le classement de la saison en cours (1 = premier) : nombre de
// joueurs avec un MMR strictement supérieur, +1. Coût raisonnable au volume
// actuel (index sur ranked_stats.mmr côté requête getLeaderboard existante).
const getRank = async (mmr: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { rank: number })[]>(
		"SELECT COUNT(*) + 1 AS rank FROM ranked_stats WHERE season = ? AND mmr > ?",
		[CURRENT_SEASON, mmr],
	);
	return rows[0]?.rank ?? 1;
};

const getProfile = async (userId: number): Promise<ProfileData | null> => {
	const [user] = await findOne(userId);
	if (!user) return null;

	const [collectionCount, soloStats, rankedStats] = await Promise.all([
		getCollectionCount(userId),
		getSoloStats(userId),
		getRankedStats(userId),
	]);

	const rank = await getRank(rankedStats.mmr);

	return {
		id: user.id,
		username: user.username,
		created_at: user.created_at,
		collection_count: collectionCount,
		solo: { wins: soloStats.wins, losses: soloStats.losses },
		ranked: { mmr: rankedStats.mmr, wins: rankedStats.wins, losses: rankedStats.losses, rank },
	};
};

export { getProfile };
