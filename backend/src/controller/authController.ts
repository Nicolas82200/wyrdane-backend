import { Request, Response } from "express";

import { authenticateSteamTicket } from "../helper/steamHelper";
import { buildAuthUrl, verifyAssertion } from "../helper/steamOpenIdHelper";
import { findBySteamId, createWithSteamAccount } from "../model/userModel";
import { grantAllCards } from "../model/collectionModel";
import { encodeJWT } from "../helper/jwtHelper";

// Retrouve (ou crée) le joueur associé à un steamid et pose le cookie de
// session. Partagé par les deux flows Steam : ticket (client Godot) et
// OpenID (site web) aboutissent tous les deux ici une fois le steamid vérifié.
const loginWithSteamId = async (
	res: Response,
	steamId: string,
): Promise<{ id: number; username: string }> => {
	const [existingUser] = await findBySteamId(steamId);
	let user: { id: number; username: string } | undefined = existingUser;
	if (!user) {
		user = await createWithSteamAccount(`Player${steamId.slice(-6)}`, steamId);
		// En dev, on débloque toute la collection pour tester le deck builder
		// sans avoir à implémenter les autres sources de déblocage (Phase 2/3).
		if (process.env.DEV_GRANT_ALL_CARDS === "true") {
			await grantAllCards(user.id);
		}
	}

	const safeUser = { id: user.id, name: user.username };
	const token = encodeJWT(safeUser);

	// En production le site et l'API sont sur des domaines différents
	// (cross-site) : le navigateur n'envoie le cookie sur les XHR que si
	// SameSite=None + Secure. En dev local (même site localhost), Lax suffit
	// et évite d'exiger HTTPS.
	const isProduction = process.env.NODE_ENV === "production";
	res.cookie("auth_token", `Bearer ${token}`, {
		httpOnly: true,
		secure: isProduction,
		sameSite: isProduction ? "none" : "lax",
		maxAge: 60 * 60 * 1000,
	});

	return user;
};

// Appelé par le client Godot : envoie le ticket de session Steam obtenu
// côté client (Steam.getAuthSessionTicket()), jamais de mot de passe.
const steamLogin = async (req: Request, res: Response): Promise<void> => {
	try {
		const { ticket } = req.body as { ticket?: string };
		if (!ticket) {
			res.status(400).json({ message: "Missing Steam ticket" });
			return;
		}

		const steamId = await authenticateSteamTicket(ticket);
		if (!steamId) {
			res.status(401).json({ message: "Invalid Steam ticket" });
			return;
		}

		const user = await loginWithSteamId(res, steamId);
		res.status(200).json({ users: { id: user.id, name: user.username } });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Étape 1 du flow web "Sign in through Steam" (OpenID) : redirige le
// navigateur vers Steam pour que le joueur s'y authentifie.
const steamOpenIdRedirect = (req: Request, res: Response): void => {
	const backendUrl = process.env.BACKEND_URL as string;
	const returnTo = `${backendUrl}/api/auth/steam/callback`;
	res.redirect(buildAuthUrl(returnTo, backendUrl));
};

// Étape 2 : Steam redirige ici avec des paramètres openid.* signés, qu'on
// revalide auprès de Steam avant de faire confiance au steamid renvoyé.
const steamOpenIdCallback = async (req: Request, res: Response): Promise<void> => {
	try {
		const query = req.query as Record<string, string>;
		const steamId = await verifyAssertion(query);
		if (!steamId) {
			res.status(401).json({ message: "Invalid Steam OpenID assertion" });
			return;
		}

		await loginWithSteamId(res, steamId);
		res.redirect(process.env.FRONTEND_URL as string);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const logout = (req: Request, res: Response): void => {
	res.clearCookie("auth_token").sendStatus(200);
};

const authVerif = (req: Request, res: Response): void => {
	res.status(200).json({ authValid: true, users: req.user });
};

export { steamLogin, steamOpenIdRedirect, steamOpenIdCallback, logout, authVerif };
