import { Request, Response } from "express";

import { sendMail } from "../helper/mailHelper";
import { sendDiscordWebhook } from "../helper/discordHelper";

const CATEGORY_LABELS: Record<string, string> = {
	bug: "Bug / problème en jeu",
	question: "Question générale",
	illustrator: "Candidature illustrateur",
	partnership: "Partenariat / presse",
	other: "Autre",
};

// Catégorie envoyée sur le salon Discord de développement (même webhook que
// CrashReporter/reportsController) plutôt que par mail — les autres
// catégories (question/illustrateur/partenariat) restent par mail, une
// candidature ou une demande de partenariat n'ayant pas sa place sur ce salon.
const DISCORD_CATEGORY = "bug";
const MAX_MESSAGE_FIELD_LENGTH = 1000;

const MAX_MESSAGE_LENGTH = 5000;
const MAX_NAME_LENGTH = 200;
const MAX_PORTFOLIO_LINK_LENGTH = 500;

type ContactBody = {
	name?: string;
	email?: string;
	category?: string;
	portfolioLink?: string;
	message?: string;
	// Champ honeypot : invisible pour un humain, rempli automatiquement par
	// la plupart des bots de spam. Si présent, on répond 200 sans rien
	// envoyer, pour ne pas indiquer au bot que le filtre l'a détecté.
	website?: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const submitContact = async (req: Request, res: Response): Promise<void> => {
	try {
		const { name, email, category, portfolioLink, message, website } = req.body as ContactBody;

		if (website) {
			res.sendStatus(200);
			return;
		}

		if (!name || !email || !category || !message) {
			res.status(400).json({ message: "Champs requis manquants" });
			return;
		}
		if (!EMAIL_REGEX.test(email)) {
			res.status(400).json({ message: "Email invalide" });
			return;
		}
		if (!CATEGORY_LABELS[category]) {
			res.status(400).json({ message: "Catégorie invalide" });
			return;
		}
		if (message.length > MAX_MESSAGE_LENGTH) {
			res.status(400).json({ message: "Message trop long" });
			return;
		}
		if (name.length > MAX_NAME_LENGTH) {
			res.status(400).json({ message: "Nom trop long" });
			return;
		}
		if (portfolioLink && portfolioLink.length > MAX_PORTFOLIO_LINK_LENGTH) {
			res.status(400).json({ message: "Lien portfolio trop long" });
			return;
		}

		if (category === DISCORD_CATEGORY) {
			const messageField = message.length > MAX_MESSAGE_FIELD_LENGTH
				? `${message.slice(0, MAX_MESSAGE_FIELD_LENGTH)}… (tronqué)`
				: message;
			await sendDiscordWebhook(
				{
					title: `🐛 ${CATEGORY_LABELS[category]}`,
					color: 0xd6a94a,
					timestamp: new Date().toISOString(),
					fields: [
						{ name: "De", value: `${name} <${email}>` },
						{ name: "Message", value: messageField },
					],
				},
				`Bug (site) par ${name}`,
			);
		} else {
			const lines = [
				`Catégorie : ${CATEGORY_LABELS[category]}`,
				`De : ${name} <${email}>`,
				portfolioLink ? `Portfolio : ${portfolioLink}` : null,
				"",
				message,
			].filter((line): line is string => line !== null);

			await sendMail({
				replyTo: email,
				subject: `[Wyrdane] ${CATEGORY_LABELS[category]} - ${name} <${email}>`,
				text: lines.join("\n"),
			});
		}

		res.sendStatus(200);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { submitContact };
