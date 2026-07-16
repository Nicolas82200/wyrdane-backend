import { Request, Response } from "express";

import { authenticateSteamTicket } from "../helper/steamHelper";
import { findBySteamId, createWithSteamAccount } from "../model/userModel";
import { grantAllCards } from "../model/collectionModel";
import { encodeJWT } from "../helper/jwtHelper";

// Appelé par le client Godot (jeu) et par le site web après le flow
// "Sign in through Steam" : les deux envoient le ticket de session Steam
// obtenu côté client, jamais de mot de passe.
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

		res.cookie("auth_token", `Bearer ${token}`, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			maxAge: 60 * 60 * 1000,
		});

		res.status(200).json({ users: safeUser });
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

export { steamLogin, logout, authVerif };
