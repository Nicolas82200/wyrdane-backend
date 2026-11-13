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
	amount: number | null;
	currency: string | null;
	last_checked_at: string | null;
	created_at: string;
}

// Devise de référence : son prix vit dans `cosmetic_items.price_cents`, et
// `cosmetic_item_prices` ne porte que les AUTRES devises. Une seule source par
// devise, donc aucune paire de valeurs à tenir d'accord — voir resolvePrice.
const BASE_CURRENCY = "EUR";

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

// Prix d'un item dans `currency`, en unités mineures de cette devise (des
// cents pour EUR/USD, des yens entiers pour JPY). `null` = cet item n'est pas
// vendu dans cette devise : l'achat doit être REFUSÉ, jamais retombé sur
// l'euro. Facturer 1,99 € à un joueur à qui on vient d'afficher un prix en
// dollars est pire qu'un refus explicite, et Steam refuserait de toute façon
// une devise qui ne correspond pas à son portefeuille.
const resolvePrice = async (
	itemId: number,
	currency: string,
): Promise<number | null> => {
	const code = currency.toUpperCase();
	if (code === BASE_CURRENCY) {
		const item = await findItemById(itemId);
		return item ? item.price_cents : null;
	}
	const [rows] = await db.query<(RowDataPacket & { amount: number })[]>(
		"SELECT amount FROM cosmetic_item_prices WHERE item_id = ? AND currency = ?",
		[itemId, code],
	);
	return rows[0]?.amount ?? null;
};

// Tous les prix connus d'un coup, pour afficher le catalogue dans la devise du
// joueur sans une requête par ligne. Clé = item_id, valeur = montant ; un item
// absent du résultat n'est pas vendu dans cette devise.
const resolvePricesForCurrency = async (
	currency: string,
): Promise<Map<number, number>> => {
	const code = currency.toUpperCase();
	const prices = new Map<number, number>();
	if (code === BASE_CURRENCY) {
		const items = await getCatalog();
		for (const item of items) prices.set(item.id, item.price_cents);
		return prices;
	}
	const [rows] = await db.query<(RowDataPacket & { item_id: number; amount: number })[]>(
		"SELECT item_id, amount FROM cosmetic_item_prices WHERE currency = ?",
		[code],
	);
	for (const row of rows) prices.set(row.item_id, row.amount);
	return prices;
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
	amount: number,
	currency: string,
): Promise<number> => {
	const [result] = await db.query<ResultSetHeader>(
		`INSERT INTO purchase_ledger (user_id, item_id, order_id, status, amount, currency)
		 VALUES (?, ?, 0, 'pending', ?, ?)`,
		[userId, itemId, amount, currency.toUpperCase()],
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

// Verrouille l'achat en 'processing' avant d'appeler Steam (voir
// finalizePurchase) : deux appels concurrents à /shop/finalize pour le même
// orderId (double-clic, retry réseau) sérialisent sur le verrou de ligne
// (FOR UPDATE) au lieu de tous les deux passer le check "pending" et
// déclencher deux finalizeTxn Steam pour le même achat. Renvoie null si
// l'achat n'existe pas, n'appartient pas à userId, ou n'est plus 'pending'
// (déjà en cours ou déjà finalisé par un appel concurrent).
const lockPendingPurchase = async (
	orderId: number,
	userId: number,
): Promise<PurchaseLedgerRow | null> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query<PurchaseLedgerRow[]>(
			"SELECT * FROM purchase_ledger WHERE order_id = ? AND user_id = ? AND status = 'pending' FOR UPDATE",
			[orderId, userId],
		);
		const purchase = rows[0] ?? null;
		if (!purchase) {
			await connection.rollback();
			return null;
		}
		await connection.query("UPDATE purchase_ledger SET status = 'processing' WHERE order_id = ?", [orderId]);
		await connection.commit();
		return purchase;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Repli si finalizeTxn échoue après le verrouillage : rend l'achat à nouveau
// 'pending' pour qu'un retry (ou le joueur) puisse retenter la finalisation.
const revertToPending = async (orderId: number): Promise<void> => {
	await db.query("UPDATE purchase_ledger SET status = 'pending' WHERE order_id = ? AND status = 'processing'", [
		orderId,
	]);
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

// ─── Réconciliation (voir helper/shopReconciler.ts) ──────────────────────────

// Commandes dont on n'a jamais vu la fin, plus vieilles que `minutes` : soit le
// joueur n'a jamais rien validé, soit il a payé et on ne l'a pas su (jeu fermé
// avant l'appel de finalisation). Seul QueryTxn peut faire la différence, et
// c'est tout l'objet du réconciliateur — sans lui, un joueur du second cas a
// payé sans rien recevoir.
//
// `processing` est inclus volontairement : une finalisation interrompue en vol
// (serveur redémarré entre le verrou et la réponse de Steam) laisse la ligne
// dans cet état, et personne ne la reprendrait jamais.
const findUnfinishedPurchases = async (
	minutes: number,
	limit: number,
): Promise<PurchaseLedgerRow[]> => {
	const [rows] = await db.query<PurchaseLedgerRow[]>(
		`SELECT * FROM purchase_ledger
		 WHERE status IN ('pending', 'processing')
		   AND created_at < (NOW() - INTERVAL ? MINUTE)
		 ORDER BY created_at ASC
		 LIMIT ?`,
		[minutes, limit],
	);
	return rows;
};

// Commandes abouties à re-vérifier pour détecter un remboursement : Steam ne
// notifie rien, il faut aller le demander. On n'interroge que celles qui n'ont
// pas été vues depuis `staleHours` et qui sont plus jeunes que `withinDays`,
// par paquets — re-questionner tout l'historique à chaque tour coûterait un
// appel d'API par achat jamais remboursé, indéfiniment.
const findCompletedToRecheck = async (
	withinDays: number,
	staleHours: number,
	limit: number,
): Promise<PurchaseLedgerRow[]> => {
	const [rows] = await db.query<PurchaseLedgerRow[]>(
		`SELECT * FROM purchase_ledger
		 WHERE status = 'completed'
		   AND created_at > (NOW() - INTERVAL ? DAY)
		   AND (last_checked_at IS NULL OR last_checked_at < (NOW() - INTERVAL ? HOUR))
		 ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC
		 LIMIT ?`,
		[withinDays, staleHours, limit],
	);
	return rows;
};

const touchChecked = async (orderId: number): Promise<void> => {
	await db.query("UPDATE purchase_ledger SET last_checked_at = NOW() WHERE order_id = ?", [
		orderId,
	]);
};

// Issue définitivement perdue (rien n'a été prélevé) : on ferme la commande
// pour ne plus la repasser à chaque tour. Borné aux états non aboutis, pour ne
// jamais pouvoir « échouer » un achat déjà crédité.
const markFailed = async (orderId: number): Promise<void> => {
	await db.query(
		`UPDATE purchase_ledger SET status = 'failed', last_checked_at = NOW()
		 WHERE order_id = ? AND status IN ('pending', 'processing')`,
		[orderId],
	);
};

// Remboursement / rétrofacturation : l'argent est rendu, le cosmétique doit
// partir avec. En transaction, pour ne jamais laisser une commande marquée
// remboursée avec son cosmétique encore crédité (ou l'inverse).
//
// Le joueur peut avoir ce cosmétique sélectionné : rien à faire ici, le client
// retombe de lui-même sur le dos par défaut dès que la possession disparaît
// (voir CardBackShop.card_back_tint côté jeu).
const revokePurchase = async (orderId: number, userId: number, itemId: number): Promise<void> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		await connection.query(
			`UPDATE purchase_ledger SET status = 'refunded', last_checked_at = NOW()
			 WHERE order_id = ?`,
			[orderId],
		);
		// Une seule ligne par (user, item) : si le joueur a racheté le même
		// cosmétique après son remboursement, cette suppression lui retirerait
		// un achat valide. On ne retire donc que s'il ne reste aucune AUTRE
		// commande aboutie pour ce couple.
		const [others] = await connection.query<(RowDataPacket & { n: number })[]>(
			`SELECT COUNT(*) AS n FROM purchase_ledger
			 WHERE user_id = ? AND item_id = ? AND status = 'completed' AND order_id <> ?`,
			[userId, itemId, orderId],
		);
		if ((others[0]?.n ?? 0) === 0) {
			await connection.query(
				"DELETE FROM user_cosmetics WHERE user_id = ? AND item_id = ?",
				[userId, itemId],
			);
		}
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
	resolvePrice,
	resolvePricesForCurrency,
	createPendingPurchase,
	setTxnId,
	lockPendingPurchase,
	revertToPending,
	findPendingPurchase,
	completePurchase,
	findUnfinishedPurchases,
	findCompletedToRecheck,
	touchChecked,
	markFailed,
	revokePurchase,
	BASE_CURRENCY,
};
export type { PurchaseLedgerRow, CosmeticItemRow };
