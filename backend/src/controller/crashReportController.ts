import { Request, Response } from "express";

import { sendDiscordWebhook } from "../helper/discordHelper";

// Pas de table dédiée : même choix que reportsController (signalement joueur)
// et contactController — le rapport est simplement transmis, ici sur le salon
// Discord de développement plutôt que par mail, pour une visibilité immédiate.
// Discord tronque une valeur de field à 1024 caractères : on ne garde que la
// FIN du log (le crash/gel est toujours la dernière chose écrite avant l'arrêt),
// avec une marge sous la limite pour le préfixe "(tronqué, ...)".
const MAX_LOG_FIELD_LENGTH = 950;
const MAX_LOG_INPUT_LENGTH = 200_000; // borne large côté requête, avant troncature d'affichage
const MAX_STRING_LENGTH = 200;
const MAX_COMMENT_LENGTH = 1000;

type CrashReportBody = {
	platform?: string;
	gameVersion?: string;
	reporterName?: string;
	log?: string;
	// Ce que le joueur faisait au moment du problème, saisi librement dans la
	// popup — facultatif, aucun choix de catégorie (plantage/gel) n'est demandé
	// côté client : le commentaire libre remplace cette distinction.
	comment?: string;
	// Champ honeypot, même convention que contactController.
	website?: string;
};

const truncate = (value: string, maxLength: number): string =>
	value.length > maxLength ? value.slice(0, maxLength) : value;

const tailOf = (value: string, maxLength: number): string => {
	if (value.length <= maxLength) return value;
	return `(tronqué, dernières ${maxLength} lignes/caractères)\n…${value.slice(-maxLength)}`;
};

const submitCrashReport = async (req: Request, res: Response): Promise<void> => {
	try {
		const { platform, gameVersion, reporterName, log, comment, website } = req.body as CrashReportBody;

		if (website) {
			res.sendStatus(200);
			return;
		}

		if (!log || !log.trim()) {
			res.status(400).json({ message: "Log requis" });
			return;
		}
		if (log.length > MAX_LOG_INPUT_LENGTH) {
			res.status(400).json({ message: "Log trop volumineux" });
			return;
		}
		if (comment && comment.length > MAX_COMMENT_LENGTH) {
			res.status(400).json({ message: "Commentaire trop long" });
			return;
		}

		const safeReporterName = truncate(reporterName ?? "anonyme", MAX_STRING_LENGTH);
		const fields = [
			{ name: "Plateforme", value: truncate(platform ?? "inconnue", MAX_STRING_LENGTH), inline: true },
			{ name: "Version", value: truncate(gameVersion ?? "inconnue", MAX_STRING_LENGTH), inline: true },
			{ name: "Joueur", value: safeReporterName, inline: true },
		];
		if (comment && comment.trim()) {
			fields.push({ name: "Ce que faisait le joueur", value: truncate(comment.trim(), MAX_COMMENT_LENGTH), inline: false });
		}
		fields.push({ name: "Fin du log", value: tailOf(log.trim(), MAX_LOG_FIELD_LENGTH), inline: false });

		await sendDiscordWebhook(
			{
				title: "🔥 Plantage/gel signalé par un joueur",
				color: 0xb02e2e,
				timestamp: new Date().toISOString(),
				fields,
			},
			`Rapport de ${safeReporterName}`,
		);

		res.sendStatus(200);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { submitCrashReport };
