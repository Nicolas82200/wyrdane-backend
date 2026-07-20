import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import { credit, getBalance, countReasonToday } from "../model/currencyModel";

const SOLO_WIN_REWARD = 20;
const SOLO_WIN_DAILY_CAP = 5;
const SOLO_WIN_REASON = "match_win_solo";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

// Un match solo/vs IA n'a pas de second client pour contredire un rapport
// menteur (contrairement au flux ranked, à double rapport) : la récompense
// est donc plus faible et plafonnée par jour plutôt que non bornée.
const reportSoloMatch = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { result } = req.body as { result?: "victory" | "defeat" };
		if (result !== "victory" && result !== "defeat") {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		if (result !== "victory") {
			res.status(200).json({ credited: false, balance: await getBalance(userId) });
			return;
		}

		const alreadyToday = await countReasonToday(userId, SOLO_WIN_REASON);
		if (alreadyToday >= SOLO_WIN_DAILY_CAP) {
			res.status(200).json({ credited: false, balance: await getBalance(userId) });
			return;
		}

		await credit(userId, SOLO_WIN_REWARD, SOLO_WIN_REASON);
		res.status(200).json({ credited: true, balance: await getBalance(userId) });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { reportSoloMatch };
