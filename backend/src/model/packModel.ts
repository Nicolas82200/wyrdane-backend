import type { RowDataPacket } from "mysql2";
import db from "./db";
import { grantCard } from "./collectionModel";
import { debit, getBalance } from "./currencyModel";

import type { Cards } from "../types";

const PACK_COST = 100;
const CARDS_PER_PACK = 5;

// Pondération de tirage par rareté (somme non contrainte à 100, seul le
// ratio compte). Ajuster ici seul suffit à retoucher l'économie des packs.
const RARITY_WEIGHTS: Record<string, number> = {
	Commune: 60,
	Rare: 25,
	Épique: 12,
	Légendaire: 3,
};

interface DrawableCardRow extends Cards, RowDataPacket {}

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
const openPack = async (userId: number): Promise<{ cards: DrawableCardRow[]; balance: number }> => {
	const pool = await fetchDrawablePool();
	if (pool.length === 0) throw new Error("Aucune carte disponible pour un pack");

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		await debit(userId, PACK_COST, "pack_open", undefined, connection);

		const drawn = drawWeightedCards(pool, CARDS_PER_PACK);
		for (const card of drawn) {
			await grantCard(userId, card.id, 1, connection);
		}

		await connection.commit();
		const balance = await getBalance(userId);
		return { cards: drawn, balance };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export { PACK_COST, CARDS_PER_PACK, RARITY_WEIGHTS, openPack };
