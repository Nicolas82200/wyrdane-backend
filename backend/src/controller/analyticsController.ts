import { randomUUID } from "node:crypto";
import { Request, Response } from "express";

import { recordVisit } from "../model/analyticsModel";

const VISITOR_COOKIE = "wyrdane_visitor";
// Un an : suffisant pour distinguer un visiteur récurrent d'une nouvelle
// visite sans avoir à gérer de renouvellement particulier.
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

// Endpoint public (pas d'auth) appelé par le site à chaque navigation de page
// (voir usePageviewTracking côté site) : alimente le dashboard admin
// (visites totales / visiteurs uniques approximatifs via le cookie posé ici).
const trackPageview = async (req: Request, res: Response): Promise<void> => {
	try {
		const { path: pagePath } = req.body as { path?: string };
		if (!pagePath || typeof pagePath !== "string") {
			res.status(400).json({ message: "Missing path" });
			return;
		}

		let visitorId = req.cookies?.[VISITOR_COOKIE] as string | undefined;
		if (!visitorId) {
			visitorId = randomUUID();
			const isProduction = process.env.NODE_ENV === "production";
			res.cookie(VISITOR_COOKIE, visitorId, {
				httpOnly: true,
				secure: isProduction,
				sameSite: isProduction ? "none" : "lax",
				maxAge: VISITOR_COOKIE_MAX_AGE,
			});
		}

		await recordVisit(visitorId, pagePath.slice(0, 255));
		res.sendStatus(204);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { trackPageview };
