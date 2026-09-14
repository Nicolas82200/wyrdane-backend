import { Request, Response } from "express";

import {
	findByUserId,
	findCardsByDeckId,
	findCardsByUserId,
	findById,
	create,
	updateName,
	replaceCards,
	deleteDeck,
} from "../model/decksModel";
import { findMissing, findCardTypes, MAX_COPIES_PER_CARD } from "../model/collectionModel";
import { getUserId } from "../helper/requestUser";
import db from "../model/db";

const getUserDecks = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const decks = await findByUserId(userId);
		// Une requête pour tous les decks (JOIN) plutôt qu'un findCardsByDeckId
		// par deck (N+1) : on regroupe ensuite par deck_id en mémoire.
		const allCards = await findCardsByUserId(userId);
		const cardsByDeck = new Map<number, typeof allCards>();
		for (const card of allCards) {
			const list = cardsByDeck.get(card.deck_id) ?? [];
			list.push(card);
			cardsByDeck.set(card.deck_id, list);
		}
		const decksWithCards = decks.map((deck) => ({
			...deck,
			cards: cardsByDeck.get(deck.id) ?? [],
		}));

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

		// MAX_ENTRIES_PER_DECK largement au-dessus de ACH_MEGA_DECK (>100 cartes
		// jouables) : borne défensive contre un payload de taille absurde, pas une
		// vraie règle de deckbuilding (celle-ci vient de MAX_COPIES_PER_CARD et de
		// findMissing/cardTypes plus bas).
		const MAX_ENTRIES_PER_DECK = 300;
		const entriesAreWellFormed =
			Array.isArray(entries) &&
			entries.length <= MAX_ENTRIES_PER_DECK &&
			entries.every(
				(e) => e && typeof e.cardId === "number" && typeof e.quantity === "number" && e.quantity > 0,
			);
		if (!name || !entriesAreWellFormed) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		// Cartes-ressource exemptées : quantité illimitée dans un deck (voir
		// README « Système de Ressources par Race » côté client).
		const cardTypes = await findCardTypes(entries.map((e) => e.cardId));
		const overLimit = entries.filter(
			(e) => cardTypes.get(e.cardId) !== "Ressource" && e.quantity > MAX_COPIES_PER_CARD,
		);
		if (overLimit.length > 0) {
			res.status(400).json({
				message: `Maximum ${MAX_COPIES_PER_CARD} exemplaires par carte`,
				overLimit,
			});
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
		} else {
			deckId = 0; // affecté dans la transaction ci-dessous
		}

		// create/updateName + replaceCards dans une seule transaction : sans
		// cela, une erreur entre les deux (perte de connexion DB, etc.) pouvait
		// laisser un deck fraîchement créé sans aucune carte (orphelin).
		const connection = await db.getConnection();
		try {
			await connection.beginTransaction();
			if (paramId) {
				await updateName(deckId, name, connection);
			} else {
				deckId = await create(userId, name, connection);
			}
			await replaceCards(deckId, entries, connection);
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}

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
