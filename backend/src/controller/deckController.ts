import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import {
	findByUserId,
	findCardsByDeckId,
	findById,
	create,
	updateName,
	replaceCards,
	deleteDeck,
} from "../model/decksModel";
import { findMissing } from "../model/collectionModel";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

const getUserDecks = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const decks = await findByUserId(userId);
		const decksWithCards = await Promise.all(
			decks.map(async (deck) => {
				const cards = await findCardsByDeckId(deck.id);
				return { ...deck, cards };
			}),
		);

		res.status(200).json(decksWithCards);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const getOne = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const deckId = Number(req.params.id);
		if (Number.isNaN(deckId)) {
			res.status(400).json({ message: "Id invalide" });
			return;
		}

		const deck = await findById(deckId);
		if (!deck || deck.user_id !== userId) {
			res.status(404).json({ message: "Deck introuvable" });
			return;
		}

		const cards = await findCardsByDeckId(deck.id);
		res.status(200).json({ ...deck, cards });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const save = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { name, entries } = req.body as {
			name: string;
			entries: { cardId: number; quantity: number }[];
		};

		if (!name || !Array.isArray(entries)) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		const missing = await findMissing(userId, entries);
		if (missing.length > 0) {
			res.status(400).json({
				message: "Cartes non possédées en quantité suffisante",
				missing,
			});
			return;
		}

		const paramId = req.params.id;
		let deckId: number;

		if (paramId) {
			deckId = Number(paramId);
			const existing = await findById(deckId);
			if (!existing || existing.user_id !== userId) {
				res.status(404).json({ message: "Deck introuvable" });
				return;
			}
			await updateName(deckId, name);
		} else {
			deckId = await create(userId, name);
		}

		await replaceCards(deckId, entries);

		res.status(200).json({ id: deckId, name, entries });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const remove = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const deckId = Number(req.params.id);
		if (Number.isNaN(deckId)) {
			res.status(400).json({ message: "Id invalide" });
			return;
		}

		const deck = await findById(deckId);
		if (!deck || deck.user_id !== userId) {
			res.status(404).json({ message: "Deck introuvable" });
			return;
		}

		await deleteDeck(userId, deckId);

		res.status(204).send();
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getUserDecks, getOne, save, remove };
