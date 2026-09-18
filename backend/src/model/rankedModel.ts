import type { RowDataPacket } from "mysql2";
import db from "./db";
import { calculateElo } from "../helper/eloHelper";
import { applyXp, XP_LOSS_NETWORK, winXpForStreak } from "./levelModel";
import type { LevelReward } from "./levelModel";

const CURRENT_SEASON = 1;
const DEFAULT_MMR = 1000;

interface RankedStatsRow extends RowDataPacket {
	user_id: number;
	mmr: number;
	wins: number;
	losses: number;
	win_streak: number;
	season: number;
}

interface MatchReportRow extends RowDataPacket {
	id: number;
	client_match_id: string;
	reporter_id: number;
	opponent_id: number;
	winner_id: number;
	season: number;
	cards_played_by_race: Record<string, number> | null;
	deck_races: string[] | null;
	cards_played: string[] | null;
}

interface CardStatsRow extends RowDataPacket {
	card_name: string;
	matches_played: number;
	instances: number;
	wins: number;
}

interface MatchHistoryRow extends RowDataPacket {
	id: number;
	client_match_id: string;
	player1_id: number;
	player2_id: number;
	winner_id: number;
	season: number;
	played_at: string;
	xp_awarded_player1: number;
	xp_awarded_player2: number;
}

const getStats = async (userId: number): Promise<RankedStatsRow> => {
	await db.query(
		"INSERT INTO ranked_stats (user_id, mmr, season) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id",
		[userId, DEFAULT_MMR, CURRENT_SEASON],
	);
	const [rows] = await db.query<RankedStatsRow[]>(
		"SELECT user_id, mmr, wins, losses, win_streak, season FROM ranked_stats WHERE user_id = ?",
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
	cardsPlayedByRace: Record<string, number> | null = null,
	deckRaces: string[] | null = null,
	cardsPlayed: string[] | null = null,
): Promise<void> => {
	await db.query(
		`INSERT INTO match_reports
		 (client_match_id, reporter_id, opponent_id, winner_id, season, cards_played_by_race, deck_races, cards_played)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			clientMatchId,
			reporterId,
			opponentId,
			winnerId,
			CURRENT_SEASON,
			cardsPlayedByRace ? JSON.stringify(cardsPlayedByRace) : null,
			deckRaces ? JSON.stringify(deckRaces) : null,
			cardsPlayed ? JSON.stringify(cardsPlayed) : null,
		],
	);
};

// Une ligne par (carte, match, joueur) — voir schema.sql card_play_stats.
// Appelée une seule fois par match confirmé (même court-circuit
// findMatchHistory que le reste de reportMatch, voir rankedController) : pas
// de risque de double-comptage sur un retry réseau du même rapport. Échec
// silencieux par carte individuelle plutôt que par lot : un nom de carte
// renommé/retiré côté jeu (clé étrangère absente en pratique ici, card_name
// n'est pas une FK vers `cards` pour rester tolérant à un léger désync de
// nommage) ne doit jamais faire échouer la confirmation du match elle-même.
const recordCardPlays = async (
	clientMatchId: string,
	userId: number,
	cardsPlayed: string[] | null | undefined,
	won: boolean,
): Promise<void> => {
	if (!cardsPlayed || cardsPlayed.length === 0) return;
	const uniqueCardNames = [...new Set(cardsPlayed)];
	for (const cardName of uniqueCardNames) {
		await db.query(
			`INSERT IGNORE INTO card_play_stats (card_name, client_match_id, user_id, won, season)
			 VALUES (?, ?, ?, ?, ?)`,
			[cardName, clientMatchId, userId, won, CURRENT_SEASON],
		);
	}
};

// Cartes les plus jouées en classé (saison courante), triées par taux de jeu
// décroissant — voir docs/backend-contracts/card-stats-and-leaderboard.md
// côté card-game. minMatches : seuil sous lequel une carte est exclue (trop
// peu de données pour un winrate significatif, voir le contrat).
const MIN_MATCHES_FOR_CARD_STATS = 20;

const getTopCards = async (): Promise<{ totalRankedMatches: number; cards: CardStatsRow[] }> => {
	const [[{ total }]] = await db.query<(RowDataPacket & { total: number })[]>(
		"SELECT COUNT(*) AS total FROM match_history WHERE season = ?",
		[CURRENT_SEASON],
	);
	const [rows] = await db.query<CardStatsRow[]>(
		`SELECT card_name,
		        COUNT(DISTINCT client_match_id) AS matches_played,
		        COUNT(*) AS instances,
		        SUM(won) AS wins
		 FROM card_play_stats
		 WHERE season = ?
		 GROUP BY card_name
		 HAVING matches_played >= ?
		 ORDER BY matches_played DESC`,
		[CURRENT_SEASON, MIN_MATCHES_FOR_CARD_STATS],
	);
	return { totalRankedMatches: total, cards: rows };
};

// Valide le match : calcule le nouveau MMR des deux joueurs, met à jour leur
// série de victoires et crédite chacun en XP de compte (voir levelModel,
// winXpForStreak/XP_LOSS_NETWORK — remplace l'ancien barème d'or par match),
// en transaction pour ne jamais désynchroniser stats/historique/XP. Le
// vainqueur reçoit un multiplicateur d'XP selon sa série de victoires en
// cours (voir WIN_STREAK_XP_MULTIPLIER_TIERS dans levelModel), jamais le
// perdant (sa série retombe à 0). Renvoie l'XP gagné et le nouvel état de
// niveau de player1Id (l'appelant côté contrôleur, voir
// rankedController.reportMatch).
const confirmMatch = async (
	clientMatchId: string,
	player1Id: number,
	player2Id: number,
	winnerId: number,
): Promise<{
	xpGained: number;
	level: number;
	xp: number;
	xpToNext: number;
	rewards: LevelReward[];
	ratingA: number;
	ratingB: number;
}> => {
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
			"SELECT user_id, mmr, win_streak FROM ranked_stats WHERE user_id IN (?, ?) FOR UPDATE",
			[player1Id, player2Id],
		);
		const stats = new Map(statsRows.map((row) => [row.user_id, row]));

		const { newRatingA, newRatingB } = calculateElo(
			stats.get(player1Id)?.mmr ?? DEFAULT_MMR,
			stats.get(player2Id)?.mmr ?? DEFAULT_MMR,
			winnerId === player1Id ? 1 : 0,
		);

		const player1Won = winnerId === player1Id;
		const player2Won = winnerId === player2Id;
		const newStreak1 = player1Won ? (stats.get(player1Id)?.win_streak ?? 0) + 1 : 0;
		const newStreak2 = player2Won ? (stats.get(player2Id)?.win_streak ?? 0) + 1 : 0;
		const xpGained1 = player1Won ? winXpForStreak(newStreak1) : XP_LOSS_NETWORK;
		const xpGained2 = player2Won ? winXpForStreak(newStreak2) : XP_LOSS_NETWORK;

		await connection.query(
			"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ?, win_streak = ? WHERE user_id = ?",
			[newRatingA, player1Won ? 1 : 0, player1Won ? 0 : 1, newStreak1, player1Id],
		);
		await connection.query(
			"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ?, win_streak = ? WHERE user_id = ?",
			[newRatingB, player2Won ? 1 : 0, player2Won ? 0 : 1, newStreak2, player2Id],
		);

		// xp_awarded_player1/2 journalisent l'XP brute accordée à ce match (pas
		// l'état de niveau, qui évolue au fil des matchs suivants) : sert à
		// rankedController.reportMatch à retrouver ce montant sur un rapport
		// rejoué après confirmation, client_match_id étant UNIQUE sur cette
		// table — confirmMatch ne peut s'exécuter (et donc créditer l'XP)
		// qu'une seule fois par match, un retry réseau ne peut pas la dupliquer.
		await connection.query(
			`INSERT INTO match_history
			 (client_match_id, player1_id, player2_id, winner_id, season, xp_awarded_player1, xp_awarded_player2)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[clientMatchId, player1Id, player2Id, winnerId, CURRENT_SEASON, xpGained1, xpGained2],
		);

		const xp1 = await applyXp(player1Id, xpGained1, connection);
		await applyXp(player2Id, xpGained2, connection);

		await connection.commit();
		// xp1 est déjà l'état d'XP/niveau de player1Id dans tous les cas
		// (victoire ou défaite) : voir son calcul plus haut. ratingA/ratingB
		// renvoyés pour que l'appelant (rankedController) puisse faire
		// progresser les quêtes uniques de palier ranked sans requête
		// supplémentaire.
		return {
			xpGained: xpGained1,
			level: xp1.level,
			xp: xp1.xp,
			xpToNext: xp1.xpToNext,
			rewards: xp1.rewards,
			ratingA: newRatingA,
			ratingB: newRatingB,
		};
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
	recordCardPlays,
	getTopCards,
};
