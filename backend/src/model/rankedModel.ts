import type { RowDataPacket } from "mysql2";
import db from "./db";
import { calculateElo } from "../helper/eloHelper";

const CURRENT_SEASON = 1;
const DEFAULT_MMR = 1000;

interface RankedStatsRow extends RowDataPacket {
	user_id: number;
	mmr: number;
	wins: number;
	losses: number;
	season: number;
}

interface MatchReportRow extends RowDataPacket {
	id: number;
	client_match_id: string;
	reporter_id: number;
	opponent_id: number;
	winner_id: number;
	season: number;
}

interface MatchHistoryRow extends RowDataPacket {
	id: number;
	client_match_id: string;
	player1_id: number;
	player2_id: number;
	winner_id: number;
	season: number;
	played_at: string;
}

const getStats = async (userId: number): Promise<RankedStatsRow> => {
	await db.query(
		"INSERT INTO ranked_stats (user_id, mmr, season) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id",
		[userId, DEFAULT_MMR, CURRENT_SEASON],
	);
	const [rows] = await db.query<RankedStatsRow[]>(
		"SELECT user_id, mmr, wins, losses, season FROM ranked_stats WHERE user_id = ?",
		[userId],
	);
	return rows[0];
};

const findMatchHistory = async (
	clientMatchId: string,
): Promise<MatchHistoryRow | null> => {
	const [rows] = await db.query<MatchHistoryRow[]>(
		"SELECT * FROM match_history WHERE client_match_id = ?",
		[clientMatchId],
	);
	return rows[0] ?? null;
};

const findReport = async (
	clientMatchId: string,
	reporterId: number,
): Promise<MatchReportRow | null> => {
	const [rows] = await db.query<MatchReportRow[]>(
		"SELECT * FROM match_reports WHERE client_match_id = ? AND reporter_id = ?",
		[clientMatchId, reporterId],
	);
	return rows[0] ?? null;
};

const createReport = async (
	clientMatchId: string,
	reporterId: number,
	opponentId: number,
	winnerId: number,
): Promise<void> => {
	await db.query(
		"INSERT INTO match_reports (client_match_id, reporter_id, opponent_id, winner_id, season) VALUES (?, ?, ?, ?, ?)",
		[clientMatchId, reporterId, opponentId, winnerId, CURRENT_SEASON],
	);
};

// Valide le match : calcule le nouveau MMR des deux joueurs et enregistre
// l'historique, en transaction pour ne jamais désynchroniser stats/historique.
const confirmMatch = async (
	clientMatchId: string,
	player1Id: number,
	player2Id: number,
	winnerId: number,
): Promise<void> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		await connection.query(
			"INSERT INTO ranked_stats (user_id, mmr, season) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id",
			[player1Id, DEFAULT_MMR, CURRENT_SEASON],
		);
		await connection.query(
			"INSERT INTO ranked_stats (user_id, mmr, season) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id",
			[player2Id, DEFAULT_MMR, CURRENT_SEASON],
		);

		const [statsRows] = await connection.query<RankedStatsRow[]>(
			"SELECT user_id, mmr FROM ranked_stats WHERE user_id IN (?, ?) FOR UPDATE",
			[player1Id, player2Id],
		);
		const stats = new Map(statsRows.map((row) => [row.user_id, row.mmr]));

		const { newRatingA, newRatingB } = calculateElo(
			stats.get(player1Id) ?? DEFAULT_MMR,
			stats.get(player2Id) ?? DEFAULT_MMR,
			winnerId === player1Id ? 1 : 0,
		);

		await connection.query(
			"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ? WHERE user_id = ?",
			[newRatingA, winnerId === player1Id ? 1 : 0, winnerId === player1Id ? 0 : 1, player1Id],
		);
		await connection.query(
			"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ? WHERE user_id = ?",
			[newRatingB, winnerId === player2Id ? 1 : 0, winnerId === player2Id ? 0 : 1, player2Id],
		);

		await connection.query(
			"INSERT INTO match_history (client_match_id, player1_id, player2_id, winner_id, season) VALUES (?, ?, ?, ?, ?)",
			[clientMatchId, player1Id, player2Id, winnerId, CURRENT_SEASON],
		);

		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

const getLeaderboard = async (
	limit: number,
	offset: number,
): Promise<(RankedStatsRow & { username: string })[]> => {
	const [rows] = await db.query<(RankedStatsRow & { username: string } & RowDataPacket)[]>(
		`SELECT rs.user_id, rs.mmr, rs.wins, rs.losses, rs.season, u.username
		 FROM ranked_stats rs
		 JOIN users u ON u.id = rs.user_id
		 WHERE rs.season = ?
		 ORDER BY rs.mmr DESC
		 LIMIT ? OFFSET ?`,
		[CURRENT_SEASON, limit, offset],
	);
	return rows;
};

export {
	CURRENT_SEASON,
	getStats,
	findMatchHistory,
	findReport,
	createReport,
	confirmMatch,
	getLeaderboard,
};
