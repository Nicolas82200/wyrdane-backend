import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import {
	getCatalog,
	findItemById,
	getUserCosmetics,
	findSteamId,
	createPendingPurchase,
	setTxnId,
	findPendingPurchase,
	completePurchase,
} from "../model/shopModel";
import { initTxn, finalizeTxn } from "../helper/steamMicrotxnHelper";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

const getCatalogHandler = async (req: Request, res: Response): Promise<void> => {
	try {
		const catalog = await getCatalog();
		res.status(200).json(catalog);
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

		const orderId = await createPendingPurchase(userId, itemId);

		const transId = await initTxn(orderId, steamId, {
			itemId: item.steam_item_id,
			quantity: 1,
			amountCents: item.price_cents,
			description: item.name,
			category: item.category,
		});

		if (!transId) {
			res.status(502).json({ message: "Échec de l'initialisation Steam" });
			return;
		}

		await setTxnId(orderId, transId);

		res.status(200).json({ orderId, transId });
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

		const purchase = await findPendingPurchase(orderId, userId);
		if (!purchase) {
			res.status(404).json({ message: "Achat introuvable ou déjà finalisé" });
			return;
		}

		const success = await finalizeTxn(orderId);
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
