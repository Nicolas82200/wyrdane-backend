import { Request, Response } from "express";

import { authenticateSteamTicket, fetchSteamPersonaName } from "../helper/steamHelper";
import { buildAuthUrl, verifyAssertion, steamOpenIdRealm } from "../helper/steamOpenIdHelper";
import {
	findBySteamId,
	createWithSteamAccount,
	updateUsername,
	ensureAdminFromEnv,
} from "../model/userModel";
import { grantAllCards } from "../model/collectionModel";
import { recordLogin } from "../model/analyticsModel";
import { encodeJWT } from "../helper/jwtHelper";

// Retrouve (ou crée) le joueur associé à un steamid et pose le cookie de
// session. Partagé par les deux flows Steam : ticket (client Godot) et
// OpenID (site web) aboutissent tous les deux ici une fois le steamid vérifié.
// `source` distingue l'origine de la connexion pour le dashboard admin
// (login_events, voir analyticsModel) sans influer sur l'authentification.
const loginWithSteamId = async (
	res: Response,
	steamId: string,
	source: "site" | "game",
): Promise<{ id: number; username: string }> => {
	const [existingUser] = await findBySteamId(steamId);
	let user: { id: number; username: string } | undefined = existingUser;
	if (!user) {
		user = await createWithSteamAccount(`Player${steamId.slice(-6)}`, steamId);
		// En dev, on débloque toute la collection pour tester le deck builder
		// sans avoir à implémenter les autres sources de déblocage (Phase 2/3).
		// Garde NODE_ENV : jamais actif en prod même si le flag traîne à
		// "true" (voir DEV_SKIP_STEAM_VERIFY, même pattern).
		if (process.env.NODE_ENV !== "production" && process.env.DEV_GRANT_ALL_CARDS === "true") {
			await grantAllCards(user.id);
		}
	}

	Promise.resolve(recordLogin(user.id, source)).catch((error) =>
		console.error("recordLogin failed", error),
	);
	Promise.resolve(ensureAdminFromEnv(user.id, steamId)).catch((error) =>
		console.error("ensureAdminFromEnv failed", error),
	);

	// Pseudo réel affiché plutôt que le nom générique posé à la création
	// (`Player123456`, voir createWithSteamAccount) : récupéré à chaque login
	// pour rester à jour si le joueur change son pseudo Steam. Attendu (pas de
	// fire-and-forget) pour que la réponse de ce login reflète déjà le bon nom ;
	// n'échoue jamais le login si l'appel à Steam échoue (voir
	// fetchSteamPersonaName, qui renvoie null plutôt que de lever).
	const personaName = await fetchSteamPersonaName(steamId);
	if (personaName && personaName !== user.username) {
		await updateUsername(user.id, personaName).catch((error) =>
			console.error("updateUsername failed", error),
		);
		user = { ...user, username: personaName };
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

		const user = await loginWithSteamId(res, steamId, "game");
		res.status(200).json({ users: { id: user.id, name: user.username } });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Étape 1 du flow web "Sign in through Steam" (OpenID) : redirige le
// navigateur vers Steam pour que le joueur s'y authentifie. `?popup=1`
// (posé par AuthPanel.tsx quand la connexion se fait dans une popup plutôt
// qu'en pleine page) est répercuté dans returnTo : OpenID préserve les
// paramètres de query déjà présents sur return_to, Steam se contente d'y
// ajouter les siens (openid.*) au retour — voir steamOpenIdCallback.
const steamOpenIdRedirect = (req: Request, res: Response): void => {
	const backendUrl = process.env.BACKEND_URL as string;
	const isPopup = req.query.popup === "1";
	const returnTo = `${backendUrl}/api/auth/steam/callback${isPopup ? "?popup=1" : ""}`;
	// realm ≠ return_to : return_to reste sur l'API (où vit le callback), le
	// realm dérive du site (FRONTEND_URL) via un wildcard de sous-domaine
	// pour que Steam affiche "wyrdane.com" plutôt que "api.wyrdane.com" sur
	// son écran de connexion (voir steamOpenIdRealm).
	const realm = steamOpenIdRealm(process.env.FRONTEND_URL as string);
	res.redirect(buildAuthUrl(returnTo, realm));
};

// Page minimaliste renvoyée dans la popup de connexion (voir AuthPanel.tsx) :
// prévient la fenêtre parente du résultat via postMessage puis se ferme
// elle-même. targetOrigin=FRONTEND_URL (jamais "*") pour qu'un autre onglet
// ouvert sur un autre site ne puisse pas intercepter le message.
const sendPopupResult = (res: Response, success: boolean): void => {
	const frontendUrl = JSON.stringify(process.env.FRONTEND_URL);
	const payload = JSON.stringify({ source: "wyrdane-steam-login", success });
	res.status(200).send(`<!DOCTYPE html><html><body><script>
		if (window.opener) {
			window.opener.postMessage(${payload}, ${frontendUrl});
		}
		window.close();
	</script></body></html>`);
};

// Étape 2 : Steam redirige ici avec des paramètres openid.* signés, qu'on
// revalide auprès de Steam avant de faire confiance au steamid renvoyé.
const steamOpenIdCallback = async (req: Request, res: Response): Promise<void> => {
	const isPopup = req.query.popup === "1";
	try {
		const query = req.query as Record<string, string>;
		const steamId = await verifyAssertion(query);
		if (!steamId) {
			if (isPopup) {
				sendPopupResult(res, false);
				return;
			}
			res.status(401).json({ message: "Invalid Steam OpenID assertion" });
			return;
		}

		await loginWithSteamId(res, steamId, "site");
		if (isPopup) {
			sendPopupResult(res, true);
			return;
		}
		res.redirect(process.env.FRONTEND_URL as string);
	} catch (error) {
		console.error(error);
		if (isPopup) {
			sendPopupResult(res, false);
			return;
		}
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
