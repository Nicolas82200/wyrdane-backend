import { Request, Response } from "express";

import { joinQueue, getQueueStatus, reportLobby, abandonMatch, cancelQueue } from "../model/matchmakingModel";
import type { QueueMode } from "../model/matchmakingModel";
import { getUserId } from "../helper/requestUser";
import { isValidLobbyId } from "../helper/steamLobbyId";

const joinQueueHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		// "ranked" par défaut : tolère un client pas encore mis à jour (avant
		// l'ajout du MMR caché Normal) qui n'enverrait pas ce champ — préserve
		// le comportement classé existant sans rien casser en prod le temps du
		// déploiement.
		const rawMode = (req.body as { mode?: string })?.mode;
		const mode: QueueMode = rawMode === "normal" ? "normal" : "ranked";

		const ticketId = await joinQueue(userId, mode);
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

		// steamLobbyId doit arriver en STRING : un CSteamID 64 bits ne survit pas
		// à un number JSON (JSON.parse l'arrondit à ±8 près, l'invité rejoignait
		// alors un lobby inexistant — voir matchmakingModel.QueueStatusResult).
		// Un client pas encore mis à jour envoie encore un number : on le refuse
		// explicitement plutôt que d'enregistrer un id corrompu, l'hôte relance
		// simplement une recherche.
		const { steamLobbyId } = req.body as { steamLobbyId?: unknown };
		if (!isValidLobbyId(steamLobbyId)) {
			res.status(400).json({ message: "steamLobbyId invalide (chaîne de chiffres attendue)" });
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

// Appelé par le client quand un appariement n'a pas pu se concrétiser (entrée
// en lobby Steam refusée, hôte jamais rejoint) : remet les DEUX joueurs en file
// plutôt que de laisser chacun décider seul — voir abandonMatch pour le détail
// du blocage que ça corrige. 204 même quand il n'y avait rien à abandonner : le
// client n'a aucune action différente à mener dans ce cas, il se remet en file.
const abandonMatchHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		await abandonMatch(userId, String(req.params.ticketId));
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

export { joinQueueHandler, getQueueStatusHandler, reportLobbyHandler, abandonMatchHandler, cancelQueueHandler };
