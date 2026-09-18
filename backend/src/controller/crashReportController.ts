import { Request, Response } from "express";

import { sendDiscordWebhook } from "../helper/discordHelper";
import type { DiscordEmbedField } from "../helper/discordHelper";

// Pas de table dédiée : même choix que reportsController (signalement joueur)
// et contactController — le rapport est simplement transmis, ici sur le salon
// Discord de développement plutôt que par mail, pour une visibilité immédiate.
// Discord tronque une valeur de field à 1024 caractères : le field ne garde
// qu'un aperçu (la FIN du log, le crash/gel étant toujours la dernière chose
// écrite avant l'arrêt) — le log COMPLET est joint en pièce jointe .txt (voir
// plus bas), pour permettre de repérer d'autres erreurs plus tôt dans la
// session, pas seulement celle qui a précédé l'arrêt.
const MAX_LOG_FIELD_LENGTH = 950;
// Borne large : un vrai fichier de log de session peut atteindre plusieurs
// centaines de Ko, largement sous la limite de pièce jointe des webhooks
// Discord (25 Mo par défaut).
const MAX_LOG_INPUT_LENGTH = 5_000_000;
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
		const fields: DiscordEmbedField[] = [
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
			{ filename: `crash-log-${Date.now()}.txt`, content: log },
		);

		res.sendStatus(200);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { submitCrashReport };
