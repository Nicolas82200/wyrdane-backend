import type { RowDataPacket } from "mysql2";
import db from "./db";
import { grantCard, getOwnedQuantity, MAX_COPIES_PER_CARD, DUST_VALUE_BY_RARITY } from "./collectionModel";
import { credit, debit, getBalance } from "./currencyModel";

import type { Cards } from "../types";

const PACK_COST = 500;
const CARDS_PER_PACK = 4;

// Pondération de tirage par rareté (somme non contrainte à 100, seul le
// ratio compte). Ajuster ici seul suffit à retoucher l'économie des packs.
const RARITY_WEIGHTS: Record<string, number> = {
	Commune: 60,
	Rare: 25,
	Épique: 12,
	Légendaire: 3,
};

interface DrawableCardRow extends Cards, RowDataPacket {}

// Carte tirée telle que renvoyée au client : dusted/goldEarned informent
// l'écran d'ouverture de packs qu'un exemplaire au-delà de
// MAX_COPIES_PER_CARD a été converti en or plutôt qu'ajouté à la collection.
interface DrawResult extends DrawableCardRow {
	dusted: boolean;
	goldEarned: number;
}

// Les cartes-ressource ne sont pas de vraies récompenses de collection (une
// poignée par race, déjà données par claim-starter) : exclues du pool.
const fetchDrawablePool = async (): Promise<DrawableCardRow[]> => {
	const [rows] = await db.query<DrawableCardRow[]>(
		"SELECT * FROM cards WHERE card_type != 'Ressource'",
	);
	return rows;
};

const pickWeighted = (pool: DrawableCardRow[]): DrawableCardRow => {
	const total = pool.reduce((sum, card) => sum + (RARITY_WEIGHTS[card.rarity] ?? 0), 0);
	let roll = Math.random() * total;
	for (const card of pool) {
		roll -= RARITY_WEIGHTS[card.rarity] ?? 0;
		if (roll <= 0) return card;
	}
	return pool[pool.length - 1];
};

const drawWeightedCards = (pool: DrawableCardRow[], count: number): DrawableCardRow[] => {
	const draws: DrawableCardRow[] = [];
	for (let i = 0; i < count; i++) {
		draws.push(pickWeighted(pool));
	}
	return draws;
};

// Débite le coût, tire CARDS_PER_PACK cartes pondérées par rareté et les
// octroie au joueur, le tout en transaction (même pattern que
// rankedModel.confirmMatch : débit/octroi ne doivent jamais être partiels).
// `free` saute le débit (route dev /open-free, gardée par DEV_FREE_PACKS).
//
// Un exemplaire qui porterait la quantité possédée au-delà de
// MAX_COPIES_PER_CARD (déjà possédé, ou doublon au sein du même pack) n'est
// pas octroyé : il est converti en or (DUST_VALUE_BY_RARITY).
const openPack = async (userId: number, free = false): Promise<{ cards: DrawResult[]; balance: number }> => {
	const pool = await fetchDrawablePool();
	if (pool.length === 0) throw new Error("Aucune carte disponible pour un pack");

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		if (!free) {
			await debit(userId, PACK_COST, "pack_open", undefined, connection);
		}

		const drawn = drawWeightedCards(pool, CARDS_PER_PACK);
		const pendingQuantities = new Map<number, number>();
		const results: DrawResult[] = [];
		for (const card of drawn) {
			const alreadyOwned = await getOwnedQuantity(userId, card.id);
			const pending = pendingQuantities.get(card.id) ?? 0;
			const projectedQuantity = alreadyOwned + pending;

			if (projectedQuantity >= MAX_COPIES_PER_CARD) {
				const goldEarned = DUST_VALUE_BY_RARITY[card.rarity] ?? 0;
				await credit(userId, goldEarned, "pack_duplicate_dust", String(card.id), connection);
				results.push({ ...card, dusted: true, goldEarned });
			} else {
				await grantCard(userId, card.id, 1, connection);
				pendingQuantities.set(card.id, pending + 1);
				results.push({ ...card, dusted: false, goldEarned: 0 });
			}
		}

		await connection.commit();
		const balance = await getBalance(userId);
		return { cards: results, balance };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export { PACK_COST, CARDS_PER_PACK, RARITY_WEIGHTS, openPack };
