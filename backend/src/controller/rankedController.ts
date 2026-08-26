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
			res.status(200).json({ status: "confirmed", match: existingMatch });
			return;
		}

		const ownReport = await findReport(clientMatchId, userId);
		if (ownReport) {
			res.status(409).json({ message: "Match déjà reporté par ce joueur" });
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

		await confirmMatch(clientMatchId, userId, opponentId, winnerId);
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
		await progressWeeklyForMatch(userId, "ranked", winnerId === userId, { cardsPlayedByRace });
		await progressWeeklyForMatch(opponentId, "ranked", winnerId === opponentId, {
			cardsPlayedByRace: opponentReport.cards_played_by_race ?? undefined,
		});
		res.status(200).json({ status: "confirmed" });
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
