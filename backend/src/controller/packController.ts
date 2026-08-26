import { Request, Response } from "express";

import { openPack, openOwnedPack, PACK_COST } from "../model/packModel";
import { InsufficientFundsError, InsufficientFreePacksError } from "../model/currencyModel";
import { getUserId } from "../helper/requestUser";

const handleOpenPack = async (req: Request, res: Response, free: boolean): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { cards, balance } = await openPack(userId, free);
		res.status(200).json({ cards, balance });
	} catch (error) {
		if (error instanceof InsufficientFundsError) {
			res.status(400).json({ message: `Solde insuffisant (coût : ${PACK_COST})` });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const openPackHandler = async (req: Request, res: Response): Promise<void> =>
	handleOpenPack(req, res, false);

// Dev uniquement (flag DEV_FREE_PACKS, même pattern que DEV_GRANT_ALL_CARDS) :
// ouvre un pack sans débiter le solde, pour tester l'écran d'ouverture.
const openFreePackHandler = async (req: Request, res: Response): Promise<void> => {
	if (process.env.DEV_FREE_PACKS !== "true") {
		res.status(403).json({ message: "Packs gratuits désactivés" });
		return;
	}
	await handleOpenPack(req, res, true);
};

// Ouvre un pack en consommant le solde de packs gratuits gagnés (quêtes
// hebdo, parrainage) — distinct de openFreePackHandler ci-dessus (route dev
// sans aucun coût, gardée par DEV_FREE_PACKS).
const openOwnedPackHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { cards, free_packs } = await openOwnedPack(userId);
		res.status(200).json({ cards, free_packs });
	} catch (error) {
		if (error instanceof InsufficientFreePacksError) {
			res.status(400).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { openPackHandler, openFreePackHandler, openOwnedPackHandler };
