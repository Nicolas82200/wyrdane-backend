import { Request, Response } from "express";

import { credit, getBalance } from "../model/currencyModel";
import { incrementResult } from "../model/soloStatsModel";
import { progressForMatch } from "../model/questModel";
import { getUserId } from "../helper/requestUser";

const SOLO_WIN_BASE_REWARD = 10;
const SOLO_WIN_REASON = "match_win_solo";

const SOLO_DEFEAT_REWARD = 5;
const SOLO_DEFEAT_REASON = "match_loss_solo";

// Paliers de bonus liés à la série de victoires consécutives vs IA (voir
// soloStatsModel.incrementResult) : plus la série est longue, plus l'or gagné
// par victoire augmente ; une défaite remet immédiatement la série à 0, donc
// la victoire suivante retombe à SOLO_WIN_BASE_REWARD. Triés du palier le
// plus haut au plus bas pour que le premier match trouvé soit le bon.
const WIN_STREAK_REWARD_TIERS: { streak: number; reward: number }[] = [
	{ streak: 7, reward: 25 },
	{ streak: 5, reward: 20 },
	{ streak: 3, reward: 15 },
];

const rewardForWinStreak = (streak: number): number => {
	const tier = WIN_STREAK_REWARD_TIERS.find((candidate) => streak >= candidate.streak);
	return tier ? tier.reward : SOLO_WIN_BASE_REWARD;
};

// Un match solo/vs IA n'a pas de second client pour contredire un rapport
// menteur (contrairement au flux ranked, à double rapport) : la récompense
// est donc plus faible qu'en ranked, mais sans plafond quotidien — seule la
// série de victoires consécutives fait varier le gain, remise à 0 par
// n'importe quelle défaite. Une défaite rapporte aussi (moins qu'une
// victoire) pour garder la boucle de jeu motivante même en série perdante.
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

		const reward = won ? rewardForWinStreak(winStreak) : SOLO_DEFEAT_REWARD;
		const reason = won ? SOLO_WIN_REASON : SOLO_DEFEAT_REASON;
		await credit(userId, reward, reason);

		res.status(200).json({ credited: true, reward, winStreak, balance: await getBalance(userId) });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { reportSoloMatch };
