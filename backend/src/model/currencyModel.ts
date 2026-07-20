import type { RowDataPacket } from "mysql2";
import type { Pool, PoolConnection } from "mysql2/promise";
import db from "./db";

class InsufficientFundsError extends Error {
	constructor() {
		super("Solde insuffisant");
		this.name = "InsufficientFundsError";
	}
}

const getBalance = async (userId: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { soft_currency: number })[]>(
		"SELECT soft_currency FROM users WHERE id = ?",
		[userId],
	);
	return rows[0]?.soft_currency ?? 0;
};

// Crédite le solde et journalise le mouvement. `reference` sert à rattacher
// le mouvement à son origine (ex. client_match_id d'un match ranked) pour
// l'audit, sans contrainte d'unicité ici : l'idempotence est portée par
// l'appelant (ex. UNIQUE sur match_history.client_match_id côté ranked).
const credit = async (
	userId: number,
	amount: number,
	reason: string,
	reference?: string,
	connection?: PoolConnection,
): Promise<void> => {
	const runner: Pool | PoolConnection = connection ?? db;
	await runner.query("UPDATE users SET soft_currency = soft_currency + ? WHERE id = ?", [amount, userId]);
	await runner.query(
		"INSERT INTO currency_ledger (user_id, amount, reason, reference) VALUES (?, ?, ?, ?)",
		[userId, amount, reason, reference ?? null],
	);
};

// Débite le solde après vérification (verrouille la ligne users dans la
// transaction fournie pour éviter qu'un double appel concurrent ne passe
// sous le solde). Lève InsufficientFundsError si le solde est insuffisant.
const debit = async (
	userId: number,
	amount: number,
	reason: string,
	reference?: string,
	connection?: PoolConnection,
): Promise<void> => {
	const runner: Pool | PoolConnection = connection ?? db;
	const [rows] = await runner.query<(RowDataPacket & { soft_currency: number })[]>(
		connection ? "SELECT soft_currency FROM users WHERE id = ? FOR UPDATE" : "SELECT soft_currency FROM users WHERE id = ?",
		[userId],
	);
	const balance = rows[0]?.soft_currency ?? 0;
	if (balance < amount) throw new InsufficientFundsError();

	await runner.query("UPDATE users SET soft_currency = soft_currency - ? WHERE id = ?", [amount, userId]);
	await runner.query(
		"INSERT INTO currency_ledger (user_id, amount, reason, reference) VALUES (?, ?, ?, ?)",
		[userId, -amount, reason, reference ?? null],
	);
};

// Nombre de mouvements positifs déjà journalisés aujourd'hui pour une raison
// donnée (ex. 'match_win_solo') : base du plafond quotidien anti-farming.
const countReasonToday = async (userId: number, reason: string): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { count: number })[]>(
		`SELECT COUNT(*) AS count FROM currency_ledger
		 WHERE user_id = ? AND reason = ? AND created_at >= CURDATE()`,
		[userId, reason],
	);
	return rows[0]?.count ?? 0;
};

export { InsufficientFundsError, getBalance, credit, debit, countReasonToday };
