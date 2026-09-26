import type { RowDataPacket } from "mysql2";
import db from "./db";
import { findOne } from "./userModel";
import { getStats as getRankedStats, CURRENT_SEASON } from "./rankedModel";
import { getStats as getSoloStats } from "./soloStatsModel";
import { getLevel } from "./levelModel";

interface ProfileData {
	id: number;
	username: string;
	created_at: string;
	collection_count: number;
	solo: { wins: number; losses: number };
	ranked: { mmr: number; wins: number; losses: number; rank: number; totalPlayers: number };
	level: { level: number; xp: number; xpToNext: number };
}

const getCollectionCount = async (userId: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { count: number })[]>(
		"SELECT COALESCE(SUM(quantity), 0) AS count FROM user_cards WHERE user_id = ?",
		[userId],
	);
	return rows[0]?.count ?? 0;
};

// Position dans le classement de la saison en cours (1 = premier) : nombre de
// joueurs avec un MMR strictement supérieur, +1. Couvert par l'index
// idx_ranked_stats_season_mmr (season, mmr) — voir schema.sql.
const getRank = async (mmr: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { rank: number })[]>(
		"SELECT COUNT(*) + 1 AS `rank` FROM ranked_stats WHERE season = ? AND mmr > ?",
		[CURRENT_SEASON, mmr],
	);
	return rows[0]?.rank ?? 1;
};

// Nombre total de joueurs classés cette saison (toute ligne ranked_stats,
// y compris 0 partie jouée — voir getStats côté rankedModel, qui insère une
// ligne dès la première consultation du profil) — dénominateur affiché à
// côté du rang ("#12 / 348 joueurs", voir ProfilePanel.gd côté card-game).
const getTotalRankedPlayers = async (): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { total: number })[]>(
		"SELECT COUNT(*) AS total FROM ranked_stats WHERE season = ?",
		[CURRENT_SEASON],
	);
	return rows[0]?.total ?? 0;
};

const getProfile = async (userId: number): Promise<ProfileData | null> => {
	const [user] = await findOne(userId);
	if (!user) return null;

	const [collectionCount, soloStats, rankedStats, level] = await Promise.all([
		getCollectionCount(userId),
		getSoloStats(userId),
		getRankedStats(userId),
		getLevel(userId),
	]);

	const [rank, totalPlayers] = await Promise.all([
		getRank(rankedStats.mmr),
		getTotalRankedPlayers(),
	]);

	return {
		id: user.id,
		username: user.username,
		created_at: user.created_at,
		collection_count: collectionCount,
		solo: { wins: soloStats.wins, losses: soloStats.losses },
		ranked: { mmr: rankedStats.mmr, wins: rankedStats.wins, losses: rankedStats.losses, rank, totalPlayers },
		level,
	};
};

export { getProfile };
