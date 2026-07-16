import type { RowDataPacket, ResultSetHeader } from "mysql2";
import db from "./db";

import type { Decks } from "../types";
import type { Cards } from "../types";
interface DeckCardRow extends Cards, RowDataPacket {}
interface DeckRow extends Decks, RowDataPacket {}

const findByUserId = async (userId: number): Promise<DeckRow[]> => {
	const [rows] = await db.query<DeckRow[]>(
		"SELECT id, user_id, name, created_at FROM decks WHERE user_id = ? ORDER BY created_at DESC",
		[userId],
	);
	return rows;
};

const deleteDeck = async (userId: number, decksId: number): Promise<void> => {
	await db.query("DELETE FROM deck_cards WHERE deck_id = ?", [decksId]);
	await db.query("DELETE FROM decks WHERE id = ? AND user_id = ?", [
		decksId,
		userId,
	]);
};

const findCardsByDeckId = async (deckId: number): Promise<DeckCardRow[]> => {
	const [rows] = await db.query<DeckCardRow[]>(
		`SELECT dc.deck_id, dc.card_id, dc.quantity,
		        c.name, c.race, c.card_type, c.lane, c.cost,
		        c.attack, c.hp, c.rarity, c.charges, c.effect, c.flavor, c.image_path
		 FROM deck_cards dc
		 JOIN cards c ON c.id = dc.card_id
		 WHERE dc.deck_id = ?`,
		[deckId],
	);
	return rows;
};

const findById = async (deckId: number): Promise<DeckRow | null> => {
	const [rows] = await db.query<DeckRow[]>(
		"SELECT id, user_id, name, created_at FROM decks WHERE id = ?",
		[deckId],
	);
	return rows[0] ?? null;
};

const create = async (userId: number, name: string): Promise<number> => {
	const [result] = await db.query<ResultSetHeader>(
		"INSERT INTO decks (user_id, name) VALUES (?, ?)",
		[userId, name],
	);
	return result.insertId;
};

const updateName = async (deckId: number, name: string): Promise<void> => {
	await db.query("UPDATE decks SET name = ? WHERE id = ?", [name, deckId]);
};

const replaceCards = async (
	deckId: number,
	entries: { cardId: number; quantity: number }[],
): Promise<void> => {
	await db.query("DELETE FROM deck_cards WHERE deck_id = ?", [deckId]);
	if (entries.length === 0) return;

	const values = entries.map((e) => [deckId, e.cardId, e.quantity]);
	await db.query(
		"INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES ?",
		[values],
	);
};
export {
	findByUserId,
	findCardsByDeckId,
	findById,
	create,
	updateName,
	replaceCards,
	deleteDeck,
};
