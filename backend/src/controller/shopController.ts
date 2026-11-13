import { Request, Response } from "express";

import {
	getCatalog,
	findItemById,
	getUserCosmetics,
	findSteamId,
	resolvePrice,
	resolvePricesForCurrency,
	createPendingPurchase,
	setTxnId,
	lockPendingPurchase,
	revertToPending,
	completePurchase,
	BASE_CURRENCY,
} from "../model/shopModel";
import { initTxn, finalizeTxn, getUserInfo } from "../helper/steamMicrotxnHelper";
import { getUserId } from "../helper/requestUser";

// Devise à facturer à ce joueur : celle de son portefeuille Steam, qui est la
// seule que Steam acceptera (il ne convertit pas). Repli sur l'euro quand on
// ne peut pas la connaître — joueur non authentifié, compte sans SteamID lié,
// ou API Steam injoignable : mieux vaut un catalogue affiché en euros qu'un
// catalogue vide, et l'achat lui-même revérifiera.
const currencyForUser = async (userId: number | null): Promise<string> => {
	if (!userId) return BASE_CURRENCY;
	const steamId = await findSteamId(userId);
	if (!steamId) return BASE_CURRENCY;
	const info = await getUserInfo(steamId);
	return info?.currency ?? BASE_CURRENCY;
};

// Le catalogue est renvoyé dans la devise du joueur, pas en euros : le prix
// AFFICHÉ doit être celui qui sera FACTURÉ. Un item non vendu dans cette
// devise sort avec `price_cents: null` — le client l'affiche indisponible
// plutôt que de proposer un achat que initPurchase refuserait.
//
// Route volontairement ouverte aux requêtes non authentifiées (le site s'en
// sert aussi) : elle retombe alors sur l'euro.
const getCatalogHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const currency = await currencyForUser(getUserId(req));
		const prices = await resolvePricesForCurrency(currency);
		const catalog = await getCatalog();
		res.status(200).json(
			catalog.map((item) => ({
				...item,
				price_cents: prices.get(item.id) ?? null,
				currency,
			})),
		);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const getMyCosmetics = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const cosmetics = await getUserCosmetics(userId);
		res.status(200).json(cosmetics);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const initPurchase = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { itemId } = req.body as { itemId?: number };
		if (typeof itemId !== "number") {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		const item = await findItemById(itemId);
		if (!item) {
			res.status(404).json({ message: "Item introuvable" });
			return;
		}

		const steamId = await findSteamId(userId);
		if (!steamId) {
			res.status(400).json({ message: "Compte Steam non lié" });
			return;
		}

		// La devise du portefeuille Steam du joueur, puis le prix de l'item DANS
		// cette devise. Sans prix déclaré, on refuse : Steam n'accepte pas une
		// autre devise que celle du joueur, et le facturer en euros au montant
		// d'une devise étrangère serait pire qu'un refus (voir
		// shopModel.resolvePrice).
		const info = await getUserInfo(steamId);
		if (!info) {
			res.status(502).json({ message: "Devise du compte Steam indisponible" });
			return;
		}
		const amount = await resolvePrice(itemId, info.currency);
		if (amount === null) {
			res.status(409).json({
				message: "Article non vendu dans votre devise",
				currency: info.currency,
			});
			return;
		}

		const orderId = await createPendingPurchase(userId, itemId, amount, info.currency);

		const transId = await initTxn(orderId, steamId, {
			itemId: item.steam_item_id,
			quantity: 1,
			amount,
			currency: info.currency,
			description: item.name,
			category: item.category,
		});

		if (!transId) {
			res.status(502).json({ message: "Échec de l'initialisation Steam" });
			return;
		}

		await setTxnId(orderId, transId);

		res.status(200).json({ orderId, transId, amount, currency: info.currency });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const finalizePurchase = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { orderId } = req.body as { orderId?: number };
		if (typeof orderId !== "number") {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		const purchase = await lockPendingPurchase(orderId, userId);
		if (!purchase) {
			res.status(404).json({ message: "Achat introuvable ou déjà finalisé" });
			return;
		}

		let success = false;
		try {
			success = await finalizeTxn(orderId);
		} finally {
			if (!success) await revertToPending(orderId);
		}
		if (!success) {
			res.status(502).json({ message: "Échec de la finalisation Steam" });
			return;
		}

		await completePurchase(orderId, userId, purchase.item_id);

		res.status(200).json({ status: "completed" });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getCatalogHandler, getMyCosmetics, initPurchase, finalizePurchase };
