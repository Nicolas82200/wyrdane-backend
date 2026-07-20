import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import db from "./db";

import type { Cards } from "../types";
interface UserCardRow extends Cards, RowDataPacket {
	quantity: number;
	unlocked_at: string;
}

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

export { findByUserId, grantCard, grantAllCards, findIdsByName, findMissing };
