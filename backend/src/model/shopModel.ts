import type { RowDataPacket, ResultSetHeader } from "mysql2";
import db from "./db";

interface CosmeticItemRow extends RowDataPacket {
	id: number;
	steam_item_id: string;
	name: string;
	category: string;
	price_cents: number;
}

interface PurchaseLedgerRow extends RowDataPacket {
	id: number;
	user_id: number;
	item_id: number;
	order_id: number;
	steam_txn_id: string | null;
	status: string;
	created_at: string;
}

const getCatalog = async (): Promise<CosmeticItemRow[]> => {
	const [rows] = await db.query<CosmeticItemRow[]>(
		"SELECT * FROM cosmetic_items",
	);
	return rows;
};

const findItemById = async (itemId: number): Promise<CosmeticItemRow | null> => {
	const [rows] = await db.query<CosmeticItemRow[]>(
		"SELECT * FROM cosmetic_items WHERE id = ?",
		[itemId],
	);
	return rows[0] ?? null;
};

const getUserCosmetics = async (userId: number): Promise<CosmeticItemRow[]> => {
	const [rows] = await db.query<CosmeticItemRow[]>(
		`SELECT ci.* FROM user_cosmetics uc
		 JOIN cosmetic_items ci ON ci.id = uc.item_id
		 WHERE uc.user_id = ?`,
		[userId],
	);
	return rows;
};

const findSteamId = async (userId: number): Promise<string | null> => {
	const [rows] = await db.query<(RowDataPacket & { external_id: string })[]>(
		"SELECT external_id FROM linked_accounts WHERE user_id = ? AND provider = 'steam'",
		[userId],
	);
	return rows[0]?.external_id ?? null;
};

// Crée la ligne de ledger avant même d'appeler Steam : l'id auto-incrémenté
// sert d'orderid unique exigé par InitTxn, pas besoin d'un générateur séparé.
const createPendingPurchase = async (
	userId: number,
	itemId: number,
): Promise<number> => {
	const [result] = await db.query<ResultSetHeader>(
		"INSERT INTO purchase_ledger (user_id, item_id, order_id, status) VALUES (?, ?, 0, 'pending')",
		[userId, itemId],
	);
	const ledgerId = result.insertId;
	await db.query("UPDATE purchase_ledger SET order_id = ? WHERE id = ?", [
		ledgerId,
		ledgerId,
	]);
	return ledgerId;
};

const setTxnId = async (orderId: number, txnId: string): Promise<void> => {
	await db.query("UPDATE purchase_ledger SET steam_txn_id = ? WHERE order_id = ?", [
		txnId,
		orderId,
	]);
};

const findPendingPurchase = async (
	orderId: number,
	userId: number,
): Promise<PurchaseLedgerRow | null> => {
	const [rows] = await db.query<PurchaseLedgerRow[]>(
		"SELECT * FROM purchase_ledger WHERE order_id = ? AND user_id = ? AND status = 'pending'",
		[orderId, userId],
	);
	return rows[0] ?? null;
};

// Marque l'achat "completed" et crédite le cosmétique, en transaction pour ne
// jamais avoir un ledger validé sans l'item correspondant (ou l'inverse).
const completePurchase = async (
	orderId: number,
	userId: number,
	itemId: number,
): Promise<void> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		await connection.query(
			"UPDATE purchase_ledger SET status = 'completed' WHERE order_id = ?",
			[orderId],
		);
		await connection.query(
			`INSERT INTO user_cosmetics (user_id, item_id) VALUES (?, ?)
			 ON DUPLICATE KEY UPDATE item_id = item_id`,
			[userId, itemId],
		);

		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export {
	getCatalog,
	findItemById,
	getUserCosmetics,
	findSteamId,
	createPendingPurchase,
	setTxnId,
	findPendingPurchase,
	completePurchase,
};
