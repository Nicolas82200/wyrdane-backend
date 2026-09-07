import { Request, Response, NextFunction } from "express";

// Protection CSRF légère : exige un header personnalisé sur toute requête qui
// mute de l'état pour un utilisateur authentifié par cookie.
//
// Le cookie de session (auth_token, voir authController.loginWithSteamId) est
// posé en SameSite=None + Secure en production, car le site et l'API sont sur
// des domaines différents (cross-site). Sans ce garde-fou, un formulaire HTML
// hébergé n'importe où (ex. <form method="POST" action="https://api.wyrdane.com/api/packs/open">
// auto-soumis) est une requête CORS "simple" : pas de préflight, et le
// navigateur joint quand même le cookie de la victime si elle a une session
// active — le pack se retrouverait ouvert à ses frais sans son consentement.
//
// Exiger ce header force le navigateur à faire un préflight CORS, qui échoue
// pour toute origine autre que FRONTEND_URL (voir app.ts) : un formulaire ou
// une image externes ne peuvent pas l'ajouter, un fetch() JS cross-origin se
// fait bloquer par CORS avant même que la requête ne parte.
//
// Les deux clients légitimes (jeu Godot via BackendClient.gd, site web) DOIVENT
// envoyer ce header sur leurs requêtes authentifiées — sans quoi elles seront
// rejetées en 403 dès le déploiement de ce middleware.
const CSRF_HEADER = "x-requested-with";
const CSRF_HEADER_VALUE = "XMLHttpRequest";

const requireCsrfHeader = (req: Request, res: Response, next: NextFunction): void => {
	if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
		next();
		return;
	}
	if (req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
		res.status(403).json({ message: "Requête refusée (en-tête CSRF manquant)" });
		return;
	}
	next();
};

export default requireCsrfHeader;
