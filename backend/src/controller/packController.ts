import { Request, Response } from "express";

import { openPack, openOwnedPack, buyPacks, PACK_COST, MAX_BUY_QUANTITY } from "../model/packModel";
import {
	InsufficientFundsError,
	InsufficientFreePacksError,
	UnknownPackRaceError,
	MULTIRACE_PACK,
} from "../model/currencyModel";
import { progressForPackOpen } from "../model/uniqueQuestModel";
import { getUserId } from "../helper/requestUser";

// `race` absent = multirace, pour les builds antérieures qui n'envoient pas ce
// champ. Toute autre valeur est rejetée plus bas par le modèle (jamais
// réinterprétée en multirace : un client modifié ne doit pas pouvoir inventer
// une catégorie de stock).
const packRaceFromBody = (value: unknown): string =>
	value === undefined || value === null ? MULTIRACE_PACK : String(value);

const handleOpenPack = async (req: Request, res: Response, free: boolean): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { cards, balance } = await openPack(userId, free);
		await progressForPackOpen(userId, cards.length);
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
	if (process.env.NODE_ENV === "production" || process.env.DEV_FREE_PACKS !== "true") {
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

		const race = packRaceFromBody(req.body?.race);
		const { cards, free_packs, free_packs_by_race } = await openOwnedPack(userId, race);
		await progressForPackOpen(userId, cards.length);
		res.status(200).json({ cards, free_packs, free_packs_by_race });
	} catch (error) {
		if (error instanceof UnknownPackRaceError) {
			res.status(400).json({ message: error.message });
			return;
		}
		if (error instanceof InsufficientFreePacksError) {
			// Stock de cette race vide : refus net, jamais de repli sur une
			// autre catégorie (contrat race-packs.md).
			res.status(409).json({ message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Achat sans ouverture (voir CLAUDE.md côté card-game, refonte Boutique/
// Collection) : débite `quantity` packs d'un coup et les crédite au stock —
// l'ouverture elle-même reste réservée à /open-owned, appelée ensuite par le
// client depuis l'onglet Collection.
const buyPacksHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const quantity = Number(req.body?.quantity);
		if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BUY_QUANTITY) {
			res.status(400).json({ message: `Quantité invalide (1 à ${MAX_BUY_QUANTITY})` });
			return;
		}

		const race = packRaceFromBody(req.body?.race);
		const { balance, free_packs, free_packs_by_race } = await buyPacks(userId, quantity, race);
		res.status(200).json({ balance, free_packs, free_packs_by_race });
	} catch (error) {
		if (error instanceof UnknownPackRaceError) {
			res.status(400).json({ message: error.message });
			return;
		}
		if (error instanceof InsufficientFundsError) {
			res.status(400).json({ message: `Solde insuffisant (coût : ${PACK_COST})` });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { openPackHandler, openFreePackHandler, openOwnedPackHandler, buyPacksHandler };
