import type { RowDataPacket } from "mysql2";
import db from "./db";
import { calculateElo } from "../helper/eloHelper";
import { credit } from "./currencyModel";

const CURRENT_SEASON = 1;
const DEFAULT_MMR = 1000;

const RANKED_WIN_BASE_REWARD = 10;
const RANKED_WIN_REASON = "match_win_ranked";

const RANKED_DEFEAT_REWARD = 5;
const RANKED_DEFEAT_REASON = "match_loss_ranked";

// Même barème que l'ancienne récompense solo (voir devlog 2026-08-26) :
// désormais repris par le classé exclusivement, un match solo/vs IA ne
// rapporte plus d'or du tout (voir rewardsController.reportSoloMatch). La
// série ne compte que les victoires classées consécutives du joueur
// concerné, remise à 0 par n'importe quelle défaite — voir son propre
// win_streak dans ranked_stats, distinct de wins/losses qui ne font
// qu'accumuler. Triés du palier le plus haut au plus bas pour que le
// premier match trouvé soit le bon.
const WIN_STREAK_REWARD_TIERS: { streak: number; reward: number }[] = [
	{ streak: 7, reward: 25 },
	{ streak: 5, reward: 20 },
	{ streak: 3, reward: 15 },
];

const rewardForWinStreak = (streak: number): number => {
	const tier = WIN_STREAK_REWARD_TIERS.find((candidate) => streak >= candidate.streak);
	return tier ? tier.reward : RANKED_WIN_BASE_REWARD;
};

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
): Promise<void> => {
	await db.query(
		`INSERT INTO match_reports
		 (client_match_id, reporter_id, opponent_id, winner_id, season, cards_played_by_race, deck_races)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			clientMatchId,
			reporterId,
			opponentId,
			winnerId,
			CURRENT_SEASON,
			cardsPlayedByRace ? JSON.stringify(cardsPlayedByRace) : null,
			deckRaces ? JSON.stringify(deckRaces) : null,
		],
	);
};

// Valide le match : calcule le nouveau MMR des deux joueurs, met à jour leur
// série de victoires et crédite chacun (vainqueur comme perdant, même barème
// que l'ancienne récompense solo — voir WIN_STREAK_REWARD_TIERS), en
// transaction pour ne jamais désynchroniser stats/historique/monnaie.
// Renvoie la récompense créditée à player1Id (l'appelant côté contrôleur,
// voir rankedController.reportMatch).
const confirmMatch = async (
	clientMatchId: string,
	player1Id: number,
	player2Id: number,
	winnerId: number,
): Promise<{ reward: number }> => {
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
		const reward1 = player1Won ? rewardForWinStreak(newStreak1) : RANKED_DEFEAT_REWARD;
		const reward2 = player2Won ? rewardForWinStreak(newStreak2) : RANKED_DEFEAT_REWARD;

		await connection.query(
			"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ?, win_streak = ? WHERE user_id = ?",
			[newRatingA, player1Won ? 1 : 0, player1Won ? 0 : 1, newStreak1, player1Id],
		);
		await connection.query(
			"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ?, win_streak = ? WHERE user_id = ?",
			[newRatingB, player2Won ? 1 : 0, player2Won ? 0 : 1, newStreak2, player2Id],
		);

		await connection.query(
			"INSERT INTO match_history (client_match_id, player1_id, player2_id, winner_id, season) VALUES (?, ?, ?, ?, ?)",
			[clientMatchId, player1Id, player2Id, winnerId, CURRENT_SEASON],
		);

		// client_match_id est UNIQUE sur match_history : confirmMatch ne peut
		// s'exécuter qu'une fois par match, donc ces crédits ne peuvent pas être
		// dupliqués par un retry réseau du rapport de match. Les deux joueurs
		// sont crédités ici (contrairement à l'ancien comportement où seul le
		// vainqueur touchait quelque chose) : reference=clientMatchId permet à
		// rankedController de retrouver le montant exact de chacun sur un rapport
		// rejoué après confirmation (voir currencyModel.getCreditedAmountForReference).
		await credit(player1Id, reward1, player1Won ? RANKED_WIN_REASON : RANKED_DEFEAT_REASON, clientMatchId, connection);
		await credit(player2Id, reward2, player2Won ? RANKED_WIN_REASON : RANKED_DEFEAT_REASON, clientMatchId, connection);

		await connection.commit();
		// reward1 est déjà la récompense de player1Id dans tous les cas (victoire
		// ou défaite) : voir son calcul plus haut.
		return { reward: reward1 };
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
