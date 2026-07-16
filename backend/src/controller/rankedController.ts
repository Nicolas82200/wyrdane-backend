import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import {
	getStats,
	findMatchHistory,
	findReport,
	createReport,
	confirmMatch,
	getLeaderboard,
} from "../model/rankedModel";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

const reportMatch = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { clientMatchId, opponentId, winnerId } = req.body as {
			clientMatchId?: string;
			opponentId?: number;
			winnerId?: number;
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

		await createReport(clientMatchId, userId, opponentId, winnerId);

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
