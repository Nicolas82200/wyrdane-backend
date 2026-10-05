import { Request, Response } from "express";
import { join } from "path";

import { getStats, setWishlistCount } from "../model/analyticsModel";
import { getCardStats } from "../model/rankedModel";
import { syncCardsFromFile } from "../model/cardSyncModel";

// Ping simple pour que le site sache s'il doit afficher le lien vers le
// dashboard : n'est atteignable qu'après authorization + requireAdmin, donc
// répondre 200 ici signifie déjà "cet utilisateur est admin".
const me = (req: Request, res: Response): void => {
	res.status(200).json({ isAdmin: true });
};

const getAdminStats = async (req: Request, res: Response): Promise<void> => {
	try {
		const stats = await getStats();
		res.status(200).json(stats);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Le nombre de wishlists Steam n'est pas exposé par une API Steamworks
// publique (visible seulement dans le dashboard partenaire) : saisie
// manuelle ici, reportée par l'admin depuis ce même dashboard.
const updateWishlistCount = async (req: Request, res: Response): Promise<void> => {
	try {
		const { count } = req.body as { count?: number };
		if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
			res.status(400).json({ message: "Invalid count" });
			return;
		}

		await setWishlistCount(Math.round(count));
		res.status(200).json({ count: Math.round(count) });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Cartes les plus jouées en classé + winrate (équilibrage) — voir
// docs/backend-contracts/card-stats-and-leaderboard.md côté card-game.
// Anciennement une route joueur (/api/ranked/stats/cards/top, avec un seuil
// minimum de 20 parties) déplacée ici : pas d'écran en jeu, dashboard admin
// (wyrdane-website /admin) uniquement, sans seuil — voir getCardStats.
const getAdminCardStats = async (req: Request, res: Response): Promise<void> => {
	try {
		const { totalRankedMatches, cards } = await getCardStats();
		const cardsWithRates = cards.map((row) => ({
			card_name: row.card_name,
			play_rate: totalRankedMatches > 0 ? row.matches_played / totalRankedMatches : 0,
			matches_played: row.matches_played,
			winrate: row.instances > 0 ? row.wins / row.instances : 0,
		}));
		res.status(200).json({ total_ranked_matches: totalRankedMatches, cards: cardsWithRates });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

// Applique database/cards_data.sql (régénéré depuis card-game par
// scripts/generate-cards-data.mjs, commité à chaque resync) à la base en
// place — UPDATE par nom pour les cartes existantes, INSERT pour les
// nouvelles, ne supprime jamais de ligne (voir l'en-tête de
// cardSyncModel.ts). Équivalent HTTP de `npm run db:sync-cards`, pour les
// environnements où lancer ce script nécessiterait un accès SSH manuel au
// serveur (prod) — réservé aux admins (requireAdmin), même protection que
// le reste de ce routeur.
const syncCards = async (req: Request, res: Response): Promise<void> => {
	try {
		const cardsDataPath = join(__dirname, "..", "database", "cards_data.sql");
		const result = await syncCardsFromFile(cardsDataPath);
		res.status(200).json(result);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { me, getAdminStats, updateWishlistCount, getAdminCardStats, syncCards };
