import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import db from "./db";
import { findById as findCardById } from "./cardsModel";
import { debit, getBalance } from "./currencyModel";

import type { Cards } from "../types";
interface UserCardRow extends Cards, RowDataPacket {
	quantity: number;
	unlocked_at: string;
}

class CardNotPurchasableError extends Error {
	constructor() {
		super("Cette carte n'est pas disponible à l'achat");
		this.name = "CardNotPurchasableError";
	}
}

// Doit rester synchronisé avec CurrencyManager.CARD_PRICE_BY_RARITY côté
// client Godot (E:\card-game\scripts\collection\CurrencyManager.gd) — même
// tarification, affichée là-bas à titre indicatif, appliquée et vérifiée ici.
const CARD_PRICE_BY_RARITY: Record<string, number> = {
	Commune: 100,
	Rare: 150,
	Épique: 200,
	Légendaire: 250,
};

// Doit rester synchronisé avec DeckBuilder.MAX_COPIES côté client Godot
// (E:\card-game\scripts\deck\DeckBuilder.gd) et MAX_COPIES_PER_CARD dans
// deckController.ts — plafond de copies utilisables d'une carte dans un deck.
const MAX_COPIES_PER_CARD = 4;

// Or reçu à la place d'un exemplaire de pack qui dépasserait
// MAX_COPIES_PER_CARD (voir packModel.openPack) — même logique que la
// destruction/dust d'un TCG classique, montants par rareté.
const DUST_VALUE_BY_RARITY: Record<string, number> = {
	Commune: 25,
	Rare: 50,
	Épique: 75,
	Légendaire: 100,
};

const findByUserId = async (userId: number): Promise<UserCardRow[]> => {
	const [rows] = await db.query<UserCardRow[]>(
		`SELECT c.id, c.name, c.race, c.card_type, c.lane, c.cost,
		        c.attack, c.hp, c.rarity, c.charges, c.effect, c.flavor, c.image_path,
		        uc.quantity, uc.unlocked_at
		 FROM user_cards uc
		 JOIN cards c ON c.id = uc.card_id
		 WHERE uc.user_id = ?`,
		[userId],
	);
	return rows;
};

// Accorde (ou complète) la possession d'une carte pour un joueur. Utilisée en
// interne (fin de partie, boutique, seed dev) : pas de route HTTP publique.
const grantCard = async (
	userId: number,
	cardId: number,
	quantity = 1,
	connection?: PoolConnection,
): Promise<void> => {
	const runner = connection ?? db;
	await runner.query(
		`INSERT INTO user_cards (user_id, card_id, quantity)
		 VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
		[userId, cardId, quantity],
	);
};

// 40 par carte : au-delà du max de copies d'un serviteur/sort (4) et large
// pour les cartes-ressource, qui n'ont pas de plafond de copies dans un deck.
const DEV_GRANT_QUANTITY = 40;

const grantAllCards = async (userId: number): Promise<void> => {
	await db.query(
		`INSERT INTO user_cards (user_id, card_id, quantity)
		 SELECT ?, id, ? FROM cards
		 ON DUPLICATE KEY UPDATE quantity = quantity`,
		[userId, DEV_GRANT_QUANTITY],
	);
};

// Résout un lot de noms de cartes vers leurs id (voir POST
// /api/collection/claim-starter, qui référence les cartes des decks de départ
// par nom plutôt que par id pour rester lisible/maintenable côté code).
const findIdsByName = async (
	names: string[],
	connection?: PoolConnection,
): Promise<Map<string, number>> => {
	if (names.length === 0) return new Map();
	const runner = connection ?? db;
	const [rows] = await runner.query<(RowDataPacket & { id: number; name: string })[]>(
		"SELECT id, name FROM cards WHERE name IN (?)",
		[names],
	);
	return new Map(rows.map((row) => [row.name, row.id]));
};

// Vérifie que le joueur possède au moins la quantité demandée pour chaque
// entrée. Renvoie la liste des entrées en défaut (vide si tout est possédé).
const findMissing = async (
	userId: number,
	entries: { cardId: number; quantity: number }[],
): Promise<{ cardId: number; quantity: number }[]> => {
	if (entries.length === 0) return [];

	const [rows] = await db.query<(RowDataPacket & { card_id: number; quantity: number })[]>(
		`SELECT card_id, quantity FROM user_cards WHERE user_id = ? AND card_id IN (?)`,
		[userId, entries.map((e) => e.cardId)],
	);
	const owned = new Map(rows.map((row) => [row.card_id, row.quantity]));

	return entries.filter((e) => (owned.get(e.cardId) ?? 0) < e.quantity);
};

const getOwnedQuantity = async (userId: number, cardId: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { quantity: number })[]>(
		"SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?",
		[userId, cardId],
	);
	return rows[0]?.quantity ?? 0;
};

// Achat d'une carte à l'unité (boutique du deckbuilder) : débite le prix fixé
// par rareté et octroie un exemplaire, en transaction (même pattern que
// packModel.openPack). Les cartes-ressource sont exclues, comme du pool de
// tirage des packs (fetchDrawablePool) : ce ne sont pas de vraies récompenses
// de collection.
const buyCard = async (userId: number, cardId: number): Promise<{ balance: number; quantity: number }> => {
	const card = await findCardById(cardId);
	if (!card) throw new CardNotPurchasableError();
	// card_type est déclaré `number` dans l'interface Cards (types.ts) alors que
	// la colonne SQL est un VARCHAR — cast défensif, sans toucher ce type
	// partagé qui déborde du périmètre de cette feature.
	if (String(card.card_type) === "Ressource") throw new CardNotPurchasableError();

	const price = CARD_PRICE_BY_RARITY[card.rarity ?? ""];
	if (!price) throw new CardNotPurchasableError();

	const alreadyOwned = await getOwnedQuantity(userId, cardId);
	if (alreadyOwned >= MAX_COPIES_PER_CARD) throw new CardNotPurchasableError();

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		await debit(userId, price, "card_buy", String(cardId), connection);
		await grantCard(userId, cardId, 1, connection);

		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}

	const [balance, quantity] = await Promise.all([
		getBalance(userId),
		getOwnedQuantity(userId, cardId),
	]);
	return { balance, quantity };
};

export {
	findByUserId,
	grantCard,
	grantAllCards,
	findIdsByName,
	findMissing,
	getOwnedQuantity,
	buyCard,
	CardNotPurchasableError,
	CARD_PRICE_BY_RARITY,
	MAX_COPIES_PER_CARD,
	DUST_VALUE_BY_RARITY,
};
