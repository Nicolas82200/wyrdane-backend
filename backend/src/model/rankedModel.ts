import type { RowDataPacket } from "mysql2";
import db from "./db";
import { calculateElo } from "../helper/eloHelper";
import { applyXp, XP_LOSS_NETWORK, winXpForStreak } from "./levelModel";
import type { LevelReward } from "./levelModel";

const CURRENT_SEASON = 1;
const DEFAULT_MMR = 0;

interface RankedStatsRow extends RowDataPacket {
	user_id: number;
	mmr: number;
	hidden_mmr: number;
	wins: number;
	losses: number;
	win_streak: number;
	season: number;
}

type MatchMode = "ranked" | "normal";

interface MatchReportRow extends RowDataPacket {
	id: number;
	client_match_id: string;
	reporter_id: number;
	opponent_id: number;
	winner_id: number;
	mode: MatchMode;
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

interface PlayerMatchHistoryRow extends RowDataPacket {
	client_match_id: string;
	played_at: string;
	duration_sec: number;
	winner_id: number;
	mmr_change: number;
	opponent_username: string;
	opponent_deck_races: string[] | null;
}

const getStats = async (userId: number): Promise<RankedStatsRow> => {
	await db.query(
		"INSERT INTO ranked_stats (user_id, mmr, season) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id",
		[userId, DEFAULT_MMR, CURRENT_SEASON],
	);
	const [rows] = await db.query<RankedStatsRow[]>(
		"SELECT user_id, mmr, hidden_mmr, wins, losses, win_streak, season FROM ranked_stats WHERE user_id = ?",
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
	mode: MatchMode = "ranked",
): Promise<void> => {
	await db.query(
		`INSERT INTO match_reports
		 (client_match_id, reporter_id, opponent_id, winner_id, mode, season, cards_played_by_race, deck_races, cards_played)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			clientMatchId,
			reporterId,
			opponentId,
			winnerId,
			mode,
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
// côté card-game. Réservé au dashboard admin (wyrdane-website, /admin) :
// pas de seuil minimum de parties ici (contrairement à l'ancienne route
// joueur) — un admin doit pouvoir juger lui-même de la significativité d'un
// winrate via `matches_played`, y compris en tout début de saison.
const getCardStats = async (): Promise<{ totalRankedMatches: number; cards: CardStatsRow[] }> => {
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
		 ORDER BY matches_played DESC`,
		[CURRENT_SEASON],
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
// mode "ranked" : comportement historique inchangé — met à jour le MMR
// public (mmr), wins/losses et win_streak. mode "normal" : ne touche JAMAIS
// mmr/wins/losses (une partie Normal ne fait gagner ni perdre de points de
// classement, voir README/CLAUDE.md « Ranked ») — seul hidden_mmr (MMR caché,
// jamais affiché) évolue via la même formule Elo, pour permettre d'apparier
// des Normal de niveau similaire (voir matchmakingModel.joinQueue). win_streak
// reste partagé entre les deux modes (sert uniquement au multiplicateur d'XP,
// hors sujet du MMR/classement).
const confirmMatch = async (
	clientMatchId: string,
	player1Id: number,
	player2Id: number,
	winnerId: number,
	mode: MatchMode = "ranked",
	durationSec = 0,
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
			"SELECT user_id, mmr, hidden_mmr, win_streak FROM ranked_stats WHERE user_id IN (?, ?) FOR UPDATE",
			[player1Id, player2Id],
		);
		const stats = new Map(statsRows.map((row) => [row.user_id, row]));
		const ratingField = mode === "normal" ? "hidden_mmr" : "mmr";

		const ratingBefore1 = stats.get(player1Id)?.[ratingField] ?? DEFAULT_MMR;
		const ratingBefore2 = stats.get(player2Id)?.[ratingField] ?? DEFAULT_MMR;
		const { newRatingA, newRatingB } = calculateElo(
			ratingBefore1,
			ratingBefore2,
			winnerId === player1Id ? 1 : 0,
		);

		const player1Won = winnerId === player1Id;
		const player2Won = winnerId === player2Id;
		const newStreak1 = player1Won ? (stats.get(player1Id)?.win_streak ?? 0) + 1 : 0;
		const newStreak2 = player2Won ? (stats.get(player2Id)?.win_streak ?? 0) + 1 : 0;
		const xpGained1 = player1Won ? winXpForStreak(newStreak1) : XP_LOSS_NETWORK;
		const xpGained2 = player2Won ? winXpForStreak(newStreak2) : XP_LOSS_NETWORK;

		if (mode === "normal") {
			await connection.query(
				"UPDATE ranked_stats SET hidden_mmr = ?, win_streak = ? WHERE user_id = ?",
				[newRatingA, newStreak1, player1Id],
			);
			await connection.query(
				"UPDATE ranked_stats SET hidden_mmr = ?, win_streak = ? WHERE user_id = ?",
				[newRatingB, newStreak2, player2Id],
			);
		} else {
			await connection.query(
				"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ?, win_streak = ? WHERE user_id = ?",
				[newRatingA, player1Won ? 1 : 0, player1Won ? 0 : 1, newStreak1, player1Id],
			);
			await connection.query(
				"UPDATE ranked_stats SET mmr = ?, wins = wins + ?, losses = losses + ?, win_streak = ? WHERE user_id = ?",
				[newRatingB, player2Won ? 1 : 0, player2Won ? 0 : 1, newStreak2, player2Id],
			);
		}

		// xp_awarded_player1/2 journalisent l'XP brute accordée à ce match (pas
		// l'état de niveau, qui évolue au fil des matchs suivants) : sert à
		// rankedController.reportMatch à retrouver ce montant sur un rapport
		// rejoué après confirmation, client_match_id étant UNIQUE sur cette
		// table — confirmMatch ne peut s'exécuter (et donc créditer l'XP)
		// qu'une seule fois par match, un retry réseau ne peut pas la dupliquer.
		// mmr_change_player1/2 ne journalise jamais la variation du MMR CACHÉ
		// (mode "normal") : hidden_mmr n'est jamais exposé au client (voir son
		// commentaire sur ranked_stats plus haut), donc son delta ne doit pas
		// fuiter via l'historique de parties du profil (GET /api/ranked/matches/
		// history côté card-game) — seul un match "ranked" journalise un vrai delta.
		const mmrChange1 = mode === "ranked" ? newRatingA - ratingBefore1 : 0;
		const mmrChange2 = mode === "ranked" ? newRatingB - ratingBefore2 : 0;
		await connection.query(
			`INSERT INTO match_history
			 (client_match_id, player1_id, player2_id, winner_id, season, xp_awarded_player1, xp_awarded_player2,
			  mmr_change_player1, mmr_change_player2, duration_sec)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				clientMatchId, player1Id, player2Id, winnerId, CURRENT_SEASON, xpGained1, xpGained2,
				mmrChange1, mmrChange2, durationSec,
			],
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

// Les 20 (ou moins) dernières parties classées/rapides du joueur, adversaire
// le plus récent en tête — voir MatchHistoryPanel.gd côté card-game. Le deck
// adverse (opponent_deck_races) vient du RAPPORT de l'adversaire lui-même
// (match_reports.reporter_id = son id) : peut être absent (LEFT JOIN) pour un
// match confirmé avant l'ajout de deckRaces au payload, jamais bloquant.
// mmr_change est calculé côté SQL selon que l'appelant est player1 ou player2
// sur chaque ligne — jamais renvoyé à plat pour éviter d'exposer le MMR brut
// de l'adversaire (non pertinent ici, seul le delta du joueur importe).
const getMatchHistory = async (userId: number, limit: number): Promise<PlayerMatchHistoryRow[]> => {
	const [rows] = await db.query<PlayerMatchHistoryRow[]>(
		`SELECT
		   mh.client_match_id,
		   mh.played_at,
		   mh.duration_sec,
		   mh.winner_id,
		   IF(mh.player1_id = ?, mh.mmr_change_player1, mh.mmr_change_player2) AS mmr_change,
		   ou.username AS opponent_username,
		   mr.deck_races AS opponent_deck_races
		 FROM match_history mh
		 JOIN users ou ON ou.id = IF(mh.player1_id = ?, mh.player2_id, mh.player1_id)
		 LEFT JOIN match_reports mr
		   ON mr.client_match_id = mh.client_match_id
		  AND mr.reporter_id = IF(mh.player1_id = ?, mh.player2_id, mh.player1_id)
		 WHERE mh.player1_id = ? OR mh.player2_id = ?
		 ORDER BY mh.played_at DESC
		 LIMIT ?`,
		[userId, userId, userId, userId, userId, limit],
	);
	return rows;
};

type LeaderboardRow = RankedStatsRow & { username: string; steam_id: string | null; rank: number };

// steam_id via LEFT JOIN (pas de garantie qu'un compte a toujours un lien
// Steam actif) — sert côté client à demander l'avatar Steamworks du joueur
// (voir docs/backend-contracts/leaderboard-browse.md côté card-game).
// `rank` calculé en SQL (fenêtre ordonnée par mmr desc sur TOUTE la saison,
// pas seulement la page demandée) pour rester correct quels que soient
// minMmr/maxMmr/offset — jamais dérivable d'un simple index de tableau côté
// client une fois qu'on filtre par palier.
const LEADERBOARD_SELECT = `
	SELECT rs.user_id, rs.mmr, rs.wins, rs.losses, rs.season, u.username, la.external_id AS steam_id,
	       RANK() OVER (ORDER BY rs.mmr DESC) AS \`rank\`
	FROM ranked_stats rs
	JOIN users u ON u.id = rs.user_id
	LEFT JOIN linked_accounts la ON la.user_id = rs.user_id AND la.provider = 'steam'
	WHERE rs.season = ? AND u.deleted_at IS NULL
`;

const getLeaderboard = async (
	limit: number,
	offset: number,
	minMmr?: number,
	maxMmr?: number,
): Promise<{ total: number; players: LeaderboardRow[] }> => {
	const hasMin = typeof minMmr === "number";
	const hasMax = typeof maxMmr === "number";
	const [[{ total }]] = await db.query<(RowDataPacket & { total: number })[]>(
		// Même filtre que LEADERBOARD_SELECT (jointure sur users pour écarter les
		// comptes anonymisés) : sans lui, le total et la page affichée pourraient
		// diverger d'une ligne.
		`SELECT COUNT(*) AS total FROM ranked_stats rs
		 JOIN users u ON u.id = rs.user_id
		 WHERE rs.season = ? AND u.deleted_at IS NULL
		 ${hasMin ? "AND rs.mmr >= ?" : ""} ${hasMax ? "AND rs.mmr < ?" : ""}`,
		[CURRENT_SEASON, ...(hasMin ? [minMmr] : []), ...(hasMax ? [maxMmr] : [])],
	);
	const [rows] = await db.query<(LeaderboardRow & RowDataPacket)[]>(
		`SELECT * FROM (${LEADERBOARD_SELECT}) ranked
		 ${hasMin || hasMax ? `WHERE ${[hasMin ? "mmr >= ?" : null, hasMax ? "mmr < ?" : null].filter(Boolean).join(" AND ")}` : ""}
		 ORDER BY mmr DESC
		 LIMIT ? OFFSET ?`,
		[CURRENT_SEASON, ...(hasMin ? [minMmr] : []), ...(hasMax ? [maxMmr] : []), limit, offset],
	);
	return { total, players: rows };
};

// Position du joueur authentifié dans le classement de la saison courante —
// null si non classé (aucune ligne ranked_stats, jamais joué de match classé).
const getMyLeaderboardPosition = async (userId: number): Promise<LeaderboardRow | null> => {
	const [rows] = await db.query<(LeaderboardRow & RowDataPacket)[]>(
		`SELECT * FROM (${LEADERBOARD_SELECT}) ranked WHERE user_id = ?`,
		[CURRENT_SEASON, userId],
	);
	return rows[0] ?? null;
};

// Page centrée sur la position du joueur authentifié au sein d'un palier
// (bornes minMmr/maxMmr) — évite au client de devoir reconstituer un offset
// depuis un rang global : le serveur compte directement combien de joueurs du
// palier ont un MMR strictement supérieur au sien pour centrer la page.
// null si le joueur n'a encore aucune ligne ranked_stats (jamais classé).
const getLeaderboardAroundUser = async (
	userId: number,
	pageSize: number,
	minMmr?: number,
	maxMmr?: number,
): Promise<{ total: number; offset: number; players: LeaderboardRow[] } | null> => {
	const me = await getMyLeaderboardPosition(userId);
	if (!me) return null;
	const hasMin = typeof minMmr === "number";
	const hasMax = typeof maxMmr === "number";
	const boundParams = [...(hasMin ? [minMmr] : []), ...(hasMax ? [maxMmr] : [])];
	const boundClause = `${hasMin ? "AND rs.mmr >= ?" : ""} ${hasMax ? "AND rs.mmr < ?" : ""}`;
	const [[{ before }]] = await db.query<(RowDataPacket & { before: number })[]>(
		// Jointure sur users pour le même filtre que LEADERBOARD_SELECT : sans elle,
		// un compte anonymisé encore porteur d'une ligne ranked_stats serait compté
		// ici mais absent de la page renvoyée juste après, et la fenêtre serait
		// décalée d'un rang. Ce cas existe : un match rapporté par l'adversaire
		// après la suppression peut recréer la ligne (voir rankedModel.confirmMatch).
		`SELECT COUNT(*) AS before FROM ranked_stats rs
		 JOIN users u ON u.id = rs.user_id
		 WHERE rs.season = ? AND u.deleted_at IS NULL AND rs.mmr > ? ${boundClause}`,
		[CURRENT_SEASON, me.mmr, ...boundParams],
	);
	const offset = Math.max(0, before - Math.floor(pageSize / 2));
	const { total, players } = await getLeaderboard(pageSize, offset, minMmr, maxMmr);
	return { total, offset, players };
};

// Recherche par pseudo (sous-chaîne, insensible à la casse) — bornée à 20
// résultats, utilisée par la barre de recherche du classement pour retrouver
// le rang exact d'un joueur (voir StatsPanel.gd côté card-game).
const searchLeaderboard = async (query: string): Promise<LeaderboardRow[]> => {
	const [rows] = await db.query<(LeaderboardRow & RowDataPacket)[]>(
		`SELECT * FROM (${LEADERBOARD_SELECT}) ranked WHERE username LIKE ? ORDER BY mmr DESC LIMIT 20`,
		[CURRENT_SEASON, `%${query}%`],
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
	getMatchHistory,
	getLeaderboard,
	getMyLeaderboardPosition,
	getLeaderboardAroundUser,
	searchLeaderboard,
	recordCardPlays,
	getCardStats,
};
export type { MatchMode };
