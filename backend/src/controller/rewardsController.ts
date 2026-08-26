import { Request, Response } from "express";

import { getBalance } from "../model/currencyModel";
import { incrementResult } from "../model/soloStatsModel";
import { progressForMatch } from "../model/questModel";
import { getUserId } from "../helper/requestUser";

// Un match solo/vs IA n'a pas de second client pour contredire un rapport
// menteur (contrairement au flux ranked, à double rapport) : aucune monnaie
// n'y est donc plus créditée depuis 2026-08-26 (l'or ne récompense que les
// matchs classés confirmés, voir rankedModel.confirmMatch) — seuls les
// stats (solo_stats) et les quêtes progressent encore ici.
const reportSoloMatch = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { result, cardsPlayedByRace, deckRaces } = req.body as {
			result?: "victory" | "defeat";
			cardsPlayedByRace?: Record<string, number>;
			deckRaces?: string[];
		};
		if (result !== "victory" && result !== "defeat") {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		const won = result === "victory";
		const winStreak = await incrementResult(userId, won);
		await progressForMatch(userId, "solo", won, { cardsPlayedByRace, deckRaces });

		res.status(200).json({ credited: false, reward: 0, winStreak, balance: await getBalance(userId) });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { reportSoloMatch };
