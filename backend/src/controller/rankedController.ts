import { Request, Response } from "express";

import {
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
} from "../model/rankedModel";
import { sanitizeCardsPlayedByRace, sanitizeDeckRaces, sanitizeCardsPlayed, sanitizeDurationSec } from "../helper/matchPayload";
import { verifyMatchSessionToken } from "../helper/matchSessionToken";
import { progressForMatch } from "../model/questModel";
import { progressForMatch as progressWeeklyForMatch } from "../model/weeklyQuestModel";
import { progressForMatch as progressMonthlyForMatch } from "../model/monthlyQuestModel";
import { progressForMatch as progressUniqueForMatch, progressForRankTier } from "../model/uniqueQuestModel";
import { getLevel } from "../model/levelModel";
import { getUserId } from "../helper/requestUser";

const reportMatch = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const rawBody = req.body as {
			clientMatchId?: string;
			opponentId?: number;
			winnerId?: number;
			cardsPlayedByRace?: Record<string, number>;
			deckRaces?: string[];
			cardsPlayed?: string[];
			matchSessionToken?: string;
			durationSec?: number;
		};
		const { clientMatchId, opponentId, winnerId, matchSessionToken } = rawBody;
		const durationSec = sanitizeDurationSec(rawBody.durationSec);

		if (
			!clientMatchId ||
			typeof opponentId !== "number" ||
			typeof winnerId !== "number" ||
			opponentId === userId ||
			(winnerId !== userId && winnerId !== opponentId)
		) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		// Preuve serveur qu'un appariement classé a réellement eu lieu entre ces
		// deux joueurs (voir TODO.md P9, matchmakingModel.pairTickets émet ce
		// jeton une seule fois par paire). ENFORCE_MATCH_SESSION_TOKEN=true fait
		// rejeter tout rapport sans jeton valide et dont le matchId encodé ne
		// correspond pas au clientMatchId déclaré ; en son absence (défaut), un
		// jeton manquant/invalide n'est que journalisé — le temps que le client
		// mis à jour (qui transmet ce jeton reçu au matchmaking) se déploie,
		// pour ne pas casser le classé en cours de route pour la version en
		// production qui ne l'envoie pas encore.
		const enforceMatchSessionToken = process.env.ENFORCE_MATCH_SESSION_TOKEN === "true";
		const sessionPayload = matchSessionToken ? verifyMatchSessionToken(matchSessionToken, userId, opponentId) : null;
		const sessionValid = sessionPayload !== null && sessionPayload.matchId === clientMatchId;
		if (!sessionValid) {
			if (enforceMatchSessionToken) {
				res.status(400).json({ message: "Session de match invalide ou absente" });
				return;
			}
			console.warn(`reportMatch sans jeton de session valide (soft mode) : user=${userId} clientMatchId=${clientMatchId}`);
		}

		// Bornage défensif : un client menteur ne peut de toute façon pas être
		// empêché de déclarer un résultat fictif sans une preuve serveur qu'une
		// vraie session P2P a eu lieu (voir le contrat de matchmaking classé) —
		// mais au moins un payload absurde (compteur à 999999, race inexistante)
		// ne peut plus fausser plusieurs quêtes/plusieurs races d'un coup.
		const cardsPlayedByRace = sanitizeCardsPlayedByRace(rawBody.cardsPlayedByRace);
		const deckRaces = sanitizeDeckRaces(rawBody.deckRaces);
		const cardsPlayed = sanitizeCardsPlayed(rawBody.cardsPlayed);

		const existingMatch = await findMatchHistory(clientMatchId);
		if (existingMatch) {
			// L'XP gagnée à CE match est déjà journalisée sur match_history
			// (xp_awarded_player1/2, voir rankedModel.confirmMatch) : pas besoin de
			// la recalculer. Les récompenses de niveau éventuellement débloquées
			// par ce match, elles, ne sont pas rejouées ici (déjà accordées une
			// seule fois lors du confirmMatch initial) — seul l'état courant de
			// niveau/XP est relu.
			const xpGained = existingMatch.player1_id === userId
				? existingMatch.xp_awarded_player1
				: existingMatch.xp_awarded_player2;
			const level = await getLevel(userId);
			res.status(200).json({ status: "confirmed", match: existingMatch, xpGained, ...level, rewards: [] });
			return;
		}

		const ownReport = await findReport(clientMatchId, userId);
		if (ownReport) {
			// Toujours en attente du rapport du pair (voir plus bas) : pas une
			// erreur — le client réessaie cet appel jusqu'à confirmation (voir
			// MatchResultReporter._report_ranked côté client), donc un second
			// appel du même joueur pour le même match est attendu et normal.
			res.status(202).json({ status: "pending" });
			return;
		}

		await createReport(clientMatchId, userId, opponentId, winnerId, cardsPlayedByRace ?? null, deckRaces ?? null, cardsPlayed ?? null);

		const opponentReport = await findReport(clientMatchId, opponentId);
		if (!opponentReport) {
			res.status(202).json({ status: "pending" });
			return;
		}

		if (
			opponentReport.opponent_id !== userId ||
			opponentReport.winner_id !== winnerId
		) {
			res.status(409).json({ status: "conflict", message: "Les rapports des deux joueurs ne concordent pas" });
			return;
		}

		const { xpGained, level, xp, xpToNext, rewards, ratingA, ratingB } = await confirmMatch(
			clientMatchId,
			userId,
			opponentId,
			winnerId,
			durationSec,
		);
		// Une fois par joueur, jamais deux fois (confirmMatch ne s'exécute qu'une
		// seule fois par match — voir le court-circuit findMatchHistory plus haut).
		// Chaque joueur ne fait progresser ses quêtes de race qu'avec les données
		// qu'il a lui-même déclarées dans son propre rapport (jamais celles de
		// l'adversaire, qui ne connaît pas son deck).
		await recordCardPlays(clientMatchId, userId, cardsPlayed, winnerId === userId);
		await recordCardPlays(clientMatchId, opponentId, opponentReport.cards_played ?? undefined, winnerId === opponentId);
		await progressForMatch(userId, "ranked", winnerId === userId, { cardsPlayedByRace, deckRaces });
		await progressForMatch(opponentId, "ranked", winnerId === opponentId, {
			cardsPlayedByRace: opponentReport.cards_played_by_race ?? undefined,
			deckRaces: opponentReport.deck_races ?? undefined,
		});
		await progressWeeklyForMatch(userId, "ranked", winnerId === userId, { cardsPlayedByRace, deckRaces });
		await progressWeeklyForMatch(opponentId, "ranked", winnerId === opponentId, {
			cardsPlayedByRace: opponentReport.cards_played_by_race ?? undefined,
			deckRaces: opponentReport.deck_races ?? undefined,
		});
		await progressMonthlyForMatch(userId, "ranked", winnerId === userId, { cardsPlayedByRace, deckRaces });
		await progressMonthlyForMatch(opponentId, "ranked", winnerId === opponentId, {
			cardsPlayedByRace: opponentReport.cards_played_by_race ?? undefined,
			deckRaces: opponentReport.deck_races ?? undefined,
		});
		await progressUniqueForMatch(userId, "ranked", winnerId === userId, { deckRaces });
		await progressUniqueForMatch(opponentId, "ranked", winnerId === opponentId, {
			deckRaces: opponentReport.deck_races ?? undefined,
		});
		// ratingA/ratingB = MMR post-match de userId/opponentId respectivement
		// (confirmMatch(clientMatchId, userId, opponentId, ...) → player1=userId).
		await progressForRankTier(userId, ratingA);
		await progressForRankTier(opponentId, ratingB);
		res.status(200).json({ status: "confirmed", xpGained, level, xp, xpToNext, rewards });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const getMyStats = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const stats = await getStats(userId);
		res.status(200).json(stats);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Historique des 20 (par défaut) dernières parties réseau du joueur —
// consommé par MatchHistoryPanel.gd côté card-game (onglet "Historique" du
// profil). Solo/IA non couverts (pas de second rapporteur, voir match_history).
const getMatchHistoryHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const limit = Math.min(Number(req.query.limit) || 20, 50);
		const history = await getMatchHistory(userId, limit);
		res.status(200).json(history);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const getLeaderboardHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const limit = Math.min(Number(req.query.limit) || 50, 100);
		const offset = Number(req.query.offset) || 0;
		const minMmr = req.query.minMmr !== undefined ? Number(req.query.minMmr) : undefined;
		const maxMmr = req.query.maxMmr !== undefined ? Number(req.query.maxMmr) : undefined;

		const leaderboard = await getLeaderboard(limit, offset, minMmr, maxMmr);
		res.status(200).json(leaderboard);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Position du joueur authentifié dans le classement — utilisé par le client
// pour sauter directement à sa propre position (voir StatsPanel.gd).
const getMyLeaderboardPositionHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const position = await getMyLeaderboardPosition(userId);
		if (!position) {
			res.status(404).json({ message: "Non classé" });
			return;
		}
		res.status(200).json(position);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const getLeaderboardAroundMeHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}
		const limit = Math.min(Number(req.query.limit) || 21, 100);
		const minMmr = req.query.minMmr !== undefined ? Number(req.query.minMmr) : undefined;
		const maxMmr = req.query.maxMmr !== undefined ? Number(req.query.maxMmr) : undefined;

		const page = await getLeaderboardAroundUser(userId, limit, minMmr, maxMmr);
		if (!page) {
			res.status(404).json({ message: "Non classé" });
			return;
		}
		res.status(200).json(page);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const searchLeaderboardHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const query = String(req.query.q ?? "").trim().slice(0, 50);
		if (!query) {
			res.status(200).json([]);
			return;
		}
		const results = await searchLeaderboard(query);
		res.status(200).json(results);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export {
	reportMatch,
	getMyStats,
	getMatchHistoryHandler,
	getLeaderboardHandler,
	getMyLeaderboardPositionHandler,
	getLeaderboardAroundMeHandler,
	searchLeaderboardHandler,
};
