import { Request, Response } from "express";

import { findUsername } from "../model/reportsModel";
import { getUserId } from "../helper/requestUser";
import { sendDiscordWebhook } from "../helper/discordHelper";
import type { DiscordEmbedField } from "../helper/discordHelper";

const TYPE_LABELS: Record<string, string> = {
	bug: "Bug",
	cheating: "Triche",
};

const MAX_DESCRIPTION_LENGTH = 3000;
// Discord tronque une valeur de field à 1024 caractères.
const MAX_DESCRIPTION_FIELD_LENGTH = 1000;

type ReportBody = {
	type?: string;
	description?: string;
	reportedUserId?: number;
	matchId?: string;
};

// Pas de table dédiée : le signalement est transmis directement sur le salon
// Discord de développement (même webhook que CrashReporter, voir
// discordHelper) — plus de mail, pour rester dans un seul endroit à suivre.
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

		const fields: DiscordEmbedField[] = [
			{ name: "Signalé par", value: `${reporterUsername} (id ${reporterId})`, inline: true },
		];

		if (typeof reportedUserId === "number") {
			const reportedUsername = (await findUsername(reportedUserId)) ?? `#${reportedUserId}`;
			fields.push({ name: "Joueur signalé", value: `${reportedUsername} (id ${reportedUserId})`, inline: true });
		}
		if (matchId) {
			fields.push({ name: "Match", value: matchId, inline: true });
		}
		const descriptionField = description.length > MAX_DESCRIPTION_FIELD_LENGTH
			? `${description.slice(0, MAX_DESCRIPTION_FIELD_LENGTH)}… (tronqué)`
			: description;
		fields.push({ name: "Description", value: descriptionField });

		await sendDiscordWebhook(
			{
				title: `🚩 Signalement ${TYPE_LABELS[type]}`,
				color: type === "cheating" ? 0xb02e2e : 0xd6a94a,
				timestamp: new Date().toISOString(),
				fields,
			},
			`${TYPE_LABELS[type]} par ${reporterUsername}`,
		);

		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { createReport };
