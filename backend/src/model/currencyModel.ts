import type { RowDataPacket } from "mysql2";
import type { Pool, PoolConnection } from "mysql2/promise";
import db from "./db";

class InsufficientFundsError extends Error {
	constructor() {
		super("Solde insuffisant");
		this.name = "InsufficientFundsError";
	}
}

class InsufficientFreePacksError extends Error {
	constructor() {
		super("Aucun pack gratuit disponible");
		this.name = "InsufficientFreePacksError";
	}
}

// Accordé explicitement à la création du compte (voir
// userModel.createWithSteamAccount) ; les comptes créés avant l'ajout de ce
// bonus le reçoivent séparément via claimStarterBonus, plus bas.
const STARTER_CURRENCY = 250;

// Quête cachée : 500 or accordés à la toute première connexion Steam d'un
// compte (jeu ou site, peu importe lequel des deux clients déclenche l'appel
// en premier — voir claimFirstLoginReward, idempotent).
const FIRST_LOGIN_REWARD = 500;

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

// Solde de packs gratuits (quêtes hebdomadaires, parrainage — voir
// weeklyQuestModel/referralModel), distinct de soft_currency. Pas de ledger
// dédié comme currency_ledger : une seule source de valeur pour l'instant,
// pas besoin d'audit fin.
const getFreePacks = async (userId: number): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { free_packs: number })[]>(
		"SELECT free_packs FROM users WHERE id = ?",
		[userId],
	);
	return rows[0]?.free_packs ?? 0;
};

const creditFreePacks = async (userId: number, amount: number, connection?: PoolConnection): Promise<void> => {
	const runner: Pool | PoolConnection = connection ?? db;
	await runner.query("UPDATE users SET free_packs = free_packs + ? WHERE id = ?", [amount, userId]);
};

// Débite un seul pack gratuit (verrouille la ligne si appelé dans une
// transaction fournie, même garde-fou anti-double-clic que debit()).
const debitFreePack = async (userId: number, connection?: PoolConnection): Promise<void> => {
	const runner: Pool | PoolConnection = connection ?? db;
	const [rows] = await runner.query<(RowDataPacket & { free_packs: number })[]>(
		connection ? "SELECT free_packs FROM users WHERE id = ? FOR UPDATE" : "SELECT free_packs FROM users WHERE id = ?",
		[userId],
	);
	const freePacks = rows[0]?.free_packs ?? 0;
	if (freePacks < 1) throw new InsufficientFreePacksError();

	await runner.query("UPDATE users SET free_packs = free_packs - 1 WHERE id = ?", [userId]);
};

// Montant total crédité/débité à un joueur pour une référence donnée (ex. un
// client_match_id ranked) : sert à retrouver après coup le montant exact
// crédité par confirmMatch sur un rapport de match rejoué une fois déjà
// confirmé (voir rankedController.reportMatch, branche "existingMatch") sans
// avoir à recalculer un barème qui peut dépendre d'un état déjà muté (série
// de victoires) entretemps.
const getCreditedAmountForReference = async (userId: number, reference: string): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { amount: number })[]>(
		"SELECT COALESCE(SUM(amount), 0) AS amount FROM currency_ledger WHERE user_id = ? AND reference = ?",
		[userId, reference],
	);
	return Number(rows[0]?.amount ?? 0);
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

// Voir POST /api/currency/claim-starter-bonus : distinct de
// userModel.hasClaimedStarter (cartes/decks de départ) — couvre les comptes
// créés avant que createWithSteamAccount n'accorde STARTER_CURRENCY à la
// création. Idempotent : un second appel est un no-op (credited: false).
const hasClaimedStarterBonus = async (userId: number): Promise<boolean> => {
	const [rows] = await db.query<(RowDataPacket & { starter_currency_claimed_at: string | null })[]>(
		"SELECT starter_currency_claimed_at FROM users WHERE id = ?",
		[userId],
	);
	return rows.length > 0 && rows[0].starter_currency_claimed_at !== null;
};

const markStarterBonusClaimed = async (userId: number, connection?: PoolConnection): Promise<void> => {
	const runner: Pool | PoolConnection = connection ?? db;
	await runner.query("UPDATE users SET starter_currency_claimed_at = NOW() WHERE id = ?", [userId]);
};

const claimStarterBonus = async (userId: number): Promise<{ credited: boolean; balance: number }> => {
	if (await hasClaimedStarterBonus(userId)) {
		return { credited: false, balance: await getBalance(userId) };
	}

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		await credit(userId, STARTER_CURRENCY, "starter_bonus", undefined, connection);
		await markStarterBonusClaimed(userId, connection);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}

	return { credited: true, balance: await getBalance(userId) };
};

// Voir POST /api/currency/claim-first-login-bonus. Idempotent comme
// claimStarterBonus : un second appel (autre client, retry réseau) est un
// no-op (credited: false).
const hasClaimedFirstLoginReward = async (userId: number): Promise<boolean> => {
	const [rows] = await db.query<(RowDataPacket & { first_login_reward_claimed_at: string | null })[]>(
		"SELECT first_login_reward_claimed_at FROM users WHERE id = ?",
		[userId],
	);
	return rows.length > 0 && rows[0].first_login_reward_claimed_at !== null;
};

const markFirstLoginRewardClaimed = async (userId: number, connection?: PoolConnection): Promise<void> => {
	const runner: Pool | PoolConnection = connection ?? db;
	await runner.query("UPDATE users SET first_login_reward_claimed_at = NOW() WHERE id = ?", [userId]);
};

const claimFirstLoginReward = async (
	userId: number,
): Promise<{ credited: boolean; balance: number; amount: number }> => {
	if (await hasClaimedFirstLoginReward(userId)) {
		return { credited: false, balance: await getBalance(userId), amount: FIRST_LOGIN_REWARD };
	}

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		await credit(userId, FIRST_LOGIN_REWARD, "first_login_reward", undefined, connection);
		await markFirstLoginRewardClaimed(userId, connection);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}

	return { credited: true, balance: await getBalance(userId), amount: FIRST_LOGIN_REWARD };
};

export {
	InsufficientFundsError,
	InsufficientFreePacksError,
	STARTER_CURRENCY,
	FIRST_LOGIN_REWARD,
	getBalance,
	credit,
	debit,
	getFreePacks,
	creditFreePacks,
	debitFreePack,
	getCreditedAmountForReference,
	countReasonToday,
	claimStarterBonus,
	claimFirstLoginReward,
};
