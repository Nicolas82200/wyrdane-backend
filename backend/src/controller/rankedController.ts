import { Request, Response } from "express";

import {
	getStats,
	findMatchHistory,
	findReport,
	createReport,
	confirmMatch,
	getLeaderboard,
} from "../model/rankedModel";
import { progressForMatch } from "../model/questModel";
import { progressForMatch as progressWeeklyForMatch } from "../model/weeklyQuestModel";
import { progressForMatch as progressUniqueForMatch, progressForRankTier } from "../model/uniqueQuestModel";
import { getBalance, getCreditedAmountForReference } from "../model/currencyModel";
import { getUserId } from "../helper/requestUser";

const reportMatch = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { clientMatchId, opponentId, winnerId, cardsPlayedByRace, deckRaces } = req.body as {
			clientMatchId?: string;
			opponentId?: number;
			winnerId?: number;
			cardsPlayedByRace?: Record<string, number>;
			deckRaces?: string[];
		};

		if (
			!clientMatchId ||
			typeof opponentId !== "number" ||
			typeof winnerId !== "number" ||
			(winnerId !== userId && winnerId !== opponentId)
		) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		const existingMatch = await findMatchHistory(clientMatchId);
		if (existingMatch) {
			// Le montant exact (vainqueur ou perdant, variable selon la série de
			// victoires au moment du match) n'est pas recalculable après coup de
			// façon fiable : on relit ce que confirmMatch a réellement crédité.
			const reward = await getCreditedAmountForReference(userId, clientMatchId);
			res.status(200).json({ status: "confirmed", match: existingMatch, reward, balance: await getBalance(userId) });
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

		await createReport(clientMatchId, userId, opponentId, winnerId, cardsPlayedByRace ?? null, deckRaces ?? null);

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

		const { reward, ratingA, ratingB } = await confirmMatch(clientMatchId, userId, opponentId, winnerId);
		// Une fois par joueur, jamais deux fois (confirmMatch ne s'exécute qu'une
		// seule fois par match — voir le court-circuit findMatchHistory plus haut).
		// Chaque joueur ne fait progresser ses quêtes de race qu'avec les données
		// qu'il a lui-même déclarées dans son propre rapport (jamais celles de
		// l'adversaire, qui ne connaît pas son deck).
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
		await progressUniqueForMatch(userId, "ranked", winnerId === userId, { deckRaces });
		await progressUniqueForMatch(opponentId, "ranked", winnerId === opponentId, {
			deckRaces: opponentReport.deck_races ?? undefined,
		});
		// ratingA/ratingB = MMR post-match de userId/opponentId respectivement
		// (confirmMatch(clientMatchId, userId, opponentId, ...) → player1=userId).
		await progressForRankTier(userId, ratingA);
		await progressForRankTier(opponentId, ratingB);
		res.status(200).json({ status: "confirmed", reward, balance: await getBalance(userId) });
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

const getLeaderboardHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const limit = Math.min(Number(req.query.limit) || 50, 100);
		const offset = Number(req.query.offset) || 0;

		const leaderboard = await getLeaderboard(limit, offset);
		res.status(200).json(leaderboard);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { reportMatch, getMyStats, getLeaderboardHandler };
