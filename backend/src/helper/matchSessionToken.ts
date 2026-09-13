import jwt from "jsonwebtoken";

// Jeton distinct du JWT de session (jwtHelper.ts) : preuve qu'un appariement
// classé a réellement eu lieu entre ces deux joueurs précis, émis une seule
// fois au moment du matchmaking (matchmakingModel.pairTickets) plutôt qu'à
// partir d'un clientMatchId auto-déclaré par le client (voir TODO.md P9).
// `scope` évite qu'un JWT d'auth (même secret) soit accepté ici par erreur.
const MATCH_SESSION_SCOPE = "match_session";
const MATCH_SESSION_TTL = "30m";

export interface MatchSessionPayload {
	scope: typeof MATCH_SESSION_SCOPE;
	matchId: string;
	playerAId: number;
	playerBId: number;
}

// matchId : identifiant serveur de la paire d'appariement (indépendant du
// clientMatchId généré côté client pour le handshake réseau) — c'est CE
// matchId, pas celui du client, qui fait foi une fois le jeton vérifié.
const issueMatchSessionToken = (matchId: string, playerAId: number, playerBId: number): string => {
	const payload: MatchSessionPayload = { scope: MATCH_SESSION_SCOPE, matchId, playerAId, playerBId };
	return jwt.sign(payload, process.env.TOKEN_SECRET as string, { expiresIn: MATCH_SESSION_TTL });
};

// Retourne le payload si le jeton est valide (signature + expiration + scope)
// ET que userId/opponentId correspondent bien à la paire encodée (dans
// n'importe quel ordre) ; null sinon — jamais d'exception, l'appelant décide
// comment traiter un jeton absent/invalide (voir rankedController.reportMatch).
const verifyMatchSessionToken = (
	token: string,
	userId: number,
	opponentId: number,
): MatchSessionPayload | null => {
	try {
		const decoded = jwt.verify(token, process.env.TOKEN_SECRET as string) as MatchSessionPayload;
		if (decoded.scope !== MATCH_SESSION_SCOPE) return null;
		const pair = [decoded.playerAId, decoded.playerBId].sort();
		const expected = [userId, opponentId].sort();
		if (pair[0] !== expected[0] || pair[1] !== expected[1]) return null;
		return decoded;
	} catch {
		return null;
	}
};

export { issueMatchSessionToken, verifyMatchSessionToken };
