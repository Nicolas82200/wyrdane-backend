import { Request, Response } from "express";

import { joinQueue, getQueueStatus, reportLobby, cancelQueue } from "../model/matchmakingModel";
import { getUserId } from "../helper/requestUser";

const joinQueueHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const ticketId = await joinQueue(userId);
		res.status(200).json({ ticket_id: ticketId });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const getQueueStatusHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const result = await getQueueStatus(userId, String(req.params.ticketId));
		res.status(200).json(result);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const reportLobbyHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { steamLobbyId } = req.body as { steamLobbyId?: number };
		if (typeof steamLobbyId !== "number" || !Number.isFinite(steamLobbyId)) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		const ok = await reportLobby(userId, String(req.params.ticketId), steamLobbyId);
		if (!ok) {
			res.status(403).json({ message: "Ticket invalide ou non hôte" });
			return;
		}
		res.status(204).end();
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const cancelQueueHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		await cancelQueue(userId, String(req.params.ticketId));
		res.status(204).end();
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { joinQueueHandler, getQueueStatusHandler, reportLobbyHandler, cancelQueueHandler };
