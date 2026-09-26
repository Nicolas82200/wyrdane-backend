import { Request, Response } from "express";

import { exportUserData, deleteUserData } from "../model/accountModel";
import { getUserId } from "../helper/requestUser";
import { markAccountDeleted } from "../middleware/deletedAccount";

// Mot de confirmation attendu pour une suppression de compte, dans les deux
// langues du jeu (voir ACCOUNT_DATA_DELETE_WORD dans translations/game.csv).
const CONFIRM_WORDS = ["SUPPRIMER", "DELETE"];

// Droits RGPD du joueur sur ses propres données (voir model/accountModel.ts
// pour ce que chaque opération touche exactement, et pourquoi la suppression
// anonymise au lieu de supprimer la ligne `users`).

const exportMyData = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const data = await exportUserData(userId);
		// Téléchargement direct plutôt qu'un JSON affiché dans le navigateur : le
		// RGPD demande une copie que la personne peut conserver.
		res.setHeader("Content-Disposition", `attachment; filename="wyrdane-donnees-${userId}.json"`);
		res.status(200).json(data);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const deleteMyAccount = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		// Confirmation explicite dans le corps de la requête : cette action est
		// irréversible, elle ne doit pas pouvoir partir d'un clic accidentel ni
		// d'une requête mal formée. Le client fait taper le mot au joueur, dans SA
		// langue (voir AccountDataPanel.gd côté jeu) — d'où les deux orthographes
		// acceptées : exiger un mot français d'un joueur anglophone transformerait
		// le garde-fou en énigme.
		const { confirm } = req.body as { confirm?: string };
		const confirmed = typeof confirm === "string" && CONFIRM_WORDS.includes(confirm.trim().toUpperCase());
		if (!confirmed) {
			res.status(400).json({ message: "Confirmation manquante" });
			return;
		}

		await deleteUserData(userId);

		// Invalide immédiatement tout JWT déjà émis pour ce compte, y compris ceux
		// d'une autre session (jeu + site ouverts en parallèle) : effacer le cookie
		// ci-dessous ne vaut que pour le client qui fait cette requête.
		markAccountDeleted(userId);

		// Le cookie de session reste valide jusqu'à 1h (voir jwtHelper) : sans cet
		// effacement, le client continuerait à agir au nom d'un compte anonymisé.
		res.clearCookie("auth_token", {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		});
		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { exportMyData, deleteMyAccount };
