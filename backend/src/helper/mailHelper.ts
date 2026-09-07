import nodemailer from "nodemailer";

// Transporteur SMTP créé à la demande (pas au chargement du module) pour que
// les variables d'environnement soient lues à l'usage, pas figées au boot -
// utile en test où NODE_ENV/les env vars SMTP_* sont mockées par test.
const buildTransporter = () =>
	nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port: Number(process.env.SMTP_PORT ?? 587),
		secure: process.env.SMTP_SECURE === "true",
		auth: {
			user: process.env.SMTP_USER,
			pass: process.env.SMTP_PASS,
		},
	});

type SendMailOptions = {
	replyTo?: string;
	subject: string;
	text: string;
};

// SMTP_FROM (adresse expéditeur validée côté fournisseur, ex. Brevo "Senders")
// est volontairement distinct de SMTP_USER (identifiant d'authentification
// SMTP) : la plupart des relais SMTP transactionnels rejettent l'envoi si le
// "from" n'est pas un expéditeur vérifié séparément.
const sendMail = async ({ replyTo, subject, text }: SendMailOptions): Promise<void> => {
	const transporter = buildTransporter();
	await transporter.sendMail({
		from: process.env.SMTP_FROM,
		to: process.env.CONTACT_EMAIL_TO,
		replyTo,
		subject,
		text,
	});
};

export { sendMail };
