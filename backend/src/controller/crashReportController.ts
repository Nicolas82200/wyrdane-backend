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

const CRASH_TYPE_LABELS: Record<string, string> = {
	crash: "Plantage",
	freeze: "Gel (fenêtre \"ne répond plus\")",
};

type CrashReportBody = {
	crashType?: string;
	platform?: string;
	gameVersion?: string;
	reporterName?: string;
	log?: string;
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
		const { crashType, platform, gameVersion, reporterName, log, website } = req.body as CrashReportBody;

		if (website) {
			res.sendStatus(200);
			return;
		}

		if (!crashType || !CRASH_TYPE_LABELS[crashType]) {
			res.status(400).json({ message: "Type de rapport invalide" });
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

		await sendDiscordWebhook({
			title: `🔥 ${CRASH_TYPE_LABELS[crashType]} signalé par un joueur`,
			color: 0xb02e2e,
			timestamp: new Date().toISOString(),
			fields: [
				{ name: "Plateforme", value: truncate(platform ?? "inconnue", MAX_STRING_LENGTH), inline: true },
				{ name: "Version", value: truncate(gameVersion ?? "inconnue", MAX_STRING_LENGTH), inline: true },
				{ name: "Joueur", value: truncate(reporterName ?? "anonyme", MAX_STRING_LENGTH), inline: true },
				{ name: "Fin du log", value: tailOf(log.trim(), MAX_LOG_FIELD_LENGTH) },
			],
		});

		res.sendStatus(200);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { submitCrashReport };
