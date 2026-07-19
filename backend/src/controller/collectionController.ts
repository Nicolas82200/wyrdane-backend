import { Request, Response } from "express";
import type { JwtPayload } from "jsonwebtoken";

import db from "../model/db";
import { findByUserId, grantCard, findIdsByName } from "../model/collectionModel";
import { create as createDeck, replaceCards } from "../model/decksModel";
import { hasClaimedStarter, markStarterClaimed } from "../model/userModel";
import { STARTER_DECKS } from "../data/starterDecks";

const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

const getCollection = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const cards = await findByUserId(userId);
		res.status(200).json(cards);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Appelée par le client (TutorialManager.notify_victory) à la fin du tutoriel :
// grante d'un coup la collection ET les 4 decks jouables des decks de départ
// (un par race, voir data/starterDecks.ts), pour que le nouveau joueur retrouve
// des decks complets dans "Mes Decks" sans étape manuelle. Idempotent : un
// second appel (retry réseau...) ne regrant ni ne recrée rien.
const claimStarter = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		if (await hasClaimedStarter(userId)) {
			res.status(200).json({ claimed: false, message: "Déjà réclamé" });
			return;
		}

		const allNames = STARTER_DECKS.flatMap((deck) => deck.entries.map((e) => e.name));
		const idsByName = await findIdsByName(allNames);
		const missing = allNames.filter((name) => !idsByName.has(name));
		if (missing.length > 0) {
			console.error("claim-starter: cartes introuvables en base :", missing);
			res.status(500).json({ message: "Catalogue de cartes incomplet" });
			return;
		}

		const connection = await db.getConnection();
		try {
			await connection.beginTransaction();

			for (const deck of STARTER_DECKS) {
				for (const entry of deck.entries) {
					await grantCard(userId, idsByName.get(entry.name) as number, entry.quantity, connection);
				}

				const deckId = await createDeck(userId, deck.deckName, connection);
				const cardEntries = deck.entries.map((entry) => ({
					cardId: idsByName.get(entry.name) as number,
					quantity: entry.quantity,
				}));
				await replaceCards(deckId, cardEntries, connection);
			}

			await markStarterClaimed(userId, connection);
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}

		res.status(200).json({ claimed: true });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getCollection, claimStarter };
