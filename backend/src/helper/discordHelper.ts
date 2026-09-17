// Notification best-effort vers un salon Discord via un webhook entrant (Paramètres
// du salon → Intégrations → Webhooks) — pas de bot à faire tourner, un simple POST
// HTTP suffit. DISCORD_CRASH_WEBHOOK_URL lu à l'usage (pas au chargement du module,
// même raison que mailHelper : rester mockable en test / configurable sans redéploiement).
// No-op silencieux si la variable n'est pas définie (dev local sans webhook configuré).

type DiscordEmbedField = {
	name: string;
	value: string;
	inline?: boolean;
};

type DiscordEmbed = {
	title?: string;
	description?: string;
	color?: number;
	fields?: DiscordEmbedField[];
	timestamp?: string;
};

// threadName : requis par Discord si le webhook est attaché à un salon de
// FORUM (chaque message y ouvre son propre fil) — ignoré sans erreur si le
// webhook est sur un salon textuel classique, donc toujours safe à fournir.
const sendDiscordWebhook = async (embed: DiscordEmbed, threadName?: string): Promise<void> => {
	const webhookUrl = process.env.DISCORD_CRASH_WEBHOOK_URL;
	if (!webhookUrl) return;

	try {
		await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				embeds: [embed],
				...(threadName ? { thread_name: threadName.slice(0, 100) } : {}),
			}),
		});
	} catch (error) {
		// Best-effort : un webhook Discord indisponible ne doit jamais faire
		// échouer la requête client qui a déclenché la notification.
		console.error("Discord webhook failed:", error);
	}
};

export { sendDiscordWebhook };
export type { DiscordEmbed, DiscordEmbedField };
