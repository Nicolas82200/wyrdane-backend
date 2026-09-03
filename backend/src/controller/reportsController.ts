import { Request, Response } from "express";

import { findUsername } from "../model/reportsModel";
import { getUserId } from "../helper/requestUser";
import { sendMail } from "../helper/mailHelper";

const TYPE_LABELS: Record<string, string> = {
	bug: "Bug",
	cheating: "Triche",
};

const MAX_DESCRIPTION_LENGTH = 3000;

type ReportBody = {
	type?: string;
	description?: string;
	reportedUserId?: number;
	matchId?: string;
};

// Pas de table dédiée : comme le formulaire de contact du site (voir
// contactController), un signalement est simplement transmis par mail à
// l'équipe — aucun panel de modération n'existe côté backend pour l'instant.
const createReport = async (req: Request, res: Response): Promise<void> => {
	try {
		const reporterId = getUserId(req);
		if (!reporterId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { type, description, reportedUserId, matchId } = req.body as ReportBody;

		if (!type || !TYPE_LABELS[type]) {
			res.status(400).json({ message: "Type de signalement invalide" });
			return;
		}
		if (!description || !description.trim()) {
			res.status(400).json({ message: "Description requise" });
			return;
		}
		if (description.length > MAX_DESCRIPTION_LENGTH) {
			res.status(400).json({ message: "Description trop longue" });
			return;
		}
		if (type === "cheating" && typeof reportedUserId !== "number") {
			res.status(400).json({ message: "Joueur signalé manquant" });
			return;
		}

		const reporterUsername = (await findUsername(reporterId)) ?? `#${reporterId}`;

		const lines = [
			`Type : ${TYPE_LABELS[type]}`,
			`Signalé par : ${reporterUsername} (id ${reporterId})`,
		];

		if (typeof reportedUserId === "number") {
			const reportedUsername = (await findUsername(reportedUserId)) ?? `#${reportedUserId}`;
			lines.push(`Joueur signalé : ${reportedUsername} (id ${reportedUserId})`);
		}
		if (matchId) {
			lines.push(`Match : ${matchId}`);
		}
		lines.push("", description);

		await sendMail({
			subject: `[Wyrdane] Signalement ${TYPE_LABELS[type]} - ${reporterUsername}`,
			text: lines.join("\n"),
		});

		res.sendStatus(200);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { createReport };
