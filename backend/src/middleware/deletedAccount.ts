// Referme la fenêtre qui s'ouvre juste après une suppression de compte (RGPD,
// voir model/accountModel.ts) : le cookie de session est effacé sur la réponse
// de la suppression, mais un JWT déjà émis reste valide jusqu'à 1h (voir
// jwtHelper) — un joueur connecté à la fois au jeu ET au site gardait donc une
// session utilisable sur un compte censé effacé, et pouvait y recréer des
// quêtes, une présence, un deck. Rien de personnel (le SteamID est libéré), mais
// un compte effacé ne doit plus rien accumuler.
//
// Une table en mémoire plutôt qu'un SELECT sur chaque requête authentifiée : la
// fenêtre à couvrir vaut exactement la durée de vie d'un JWT, donc une entrée
// vit une heure puis disparaît d'elle-même. Même hypothèse que
// middleware/rateLimit.ts (un seul process API derrière Nginx) ; à porter sur un
// store partagé si l'API est un jour répartie. Un redémarrage de l'API dans
// l'heure suivant une suppression rouvrirait la fenêtre : cas trop improbable
// pour justifier une requête en base sur chaque appel, et sans effet sur les
// données personnelles, déjà effacées définitivement.
//
// La vérification est faite dans middleware/auth.ts, seul endroit qui décide
// déjà si une session vaut quelque chose — pas dans un middleware séparé, qui
// devrait être monté après `authorization` sur chaque routeur (et ne filtrerait
// rien s'il était monté avant, `req.user` étant alors vide).
const JWT_MAX_LIFETIME_MS = 60 * 60 * 1000;

const deletedAt = new Map<number, number>();

const markAccountDeleted = (userId: number): void => {
	deletedAt.set(userId, Date.now());
};

const isAccountDeleted = (userId: number): boolean => {
	const at = deletedAt.get(userId);
	if (at === undefined) return false;
	if (Date.now() - at > JWT_MAX_LIFETIME_MS) {
		// Au-delà de la durée de vie d'un JWT, aucun token d'avant la suppression ne
		// peut plus être valide : l'entrée n'a plus d'utilité.
		deletedAt.delete(userId);
		return false;
	}
	return true;
};

const sweep = (): void => {
	const now = Date.now();
	for (const [userId, at] of deletedAt) {
		if (now - at > JWT_MAX_LIFETIME_MS) deletedAt.delete(userId);
	}
};
setInterval(sweep, 10 * 60 * 1000).unref();

// Exposé pour les tests : repart d'un état propre entre deux cas.
const _resetDeletedAccounts = (): void => {
	deletedAt.clear();
};

export { markAccountDeleted, isAccountDeleted, JWT_MAX_LIFETIME_MS, _resetDeletedAccounts };
