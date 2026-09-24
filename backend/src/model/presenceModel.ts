import db from "./db";

// Heartbeat périodique (voir router/presenceRouter.ts, PresenceService.gd
// côté client) : met à jour la dernière activité connue du joueur et si son
// dernier ping venait d'une bataille en cours. Lu par friendModel.getFriends
// pour dériver le statut en ligne/en jeu/hors ligne de chaque ami — voir
// friendModel.ONLINE_WINDOW_SECONDS pour la fenêtre de tolérance.
const heartbeat = async (userId: number, inGame: boolean): Promise<void> => {
	await db.query(
		"UPDATE users SET last_heartbeat_at = NOW(), in_game = ? WHERE id = ?",
		[inGame, userId],
	);
};

export { heartbeat };
