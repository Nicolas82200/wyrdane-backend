import { Request, Response } from "express";

import { sendMail } from "../helper/mailHelper";

const CATEGORY_LABELS: Record<string, string> = {
	bug: "Bug / problème en jeu",
	question: "Question générale",
	illustrator: "Candidature illustrateur",
	partnership: "Partenariat / presse",
	other: "Autre",
};

const MAX_MESSAGE_LENGTH = 5000;

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

		const lines = [
			`Catégorie : ${CATEGORY_LABELS[category]}`,
			`De : ${name} <${email}>`,
			portfolioLink ? `Portfolio : ${portfolioLink}` : null,
			"",
			message,
		].filter((line): line is string => line !== null);

		await sendMail({
			replyTo: email,
			subject: `[Wyrdane] ${CATEGORY_LABELS[category]} - ${name}`,
			text: lines.join("\n"),
		});

		res.sendStatus(200);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { submitContact };
