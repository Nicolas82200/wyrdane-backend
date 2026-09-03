import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import db from "./db";
import { credit, creditFreePacks } from "./currencyModel";

// Parrainage à sens unique : un joueur ne peut parrainer qu'UN SEUL ami
// (referrer_id UNIQUE en base, voir schema.sql) — contrainte anti-abus posée
// au niveau du schéma plutôt qu'en logique applicative pour ne jamais pouvoir
// être contournée par une course entre deux requêtes concurrentes.
const REFERRAL_REWARD_GOLD = 500;
const REFERRAL_REWARD_PACKS = 3;

// Alphabet sans caractères ambigus à l'oeil (0/O, 1/I) — code affiché/tapé
// manuellement par le joueur.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

const generateCode = (): string => {
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
	}
	return code;
};

interface ReferralRow extends RowDataPacket {
	id: number;
	referrer_id: number;
	code: string;
	referred_id: number | null;
	redeemed_at: string | null;
	completed_at: string | null;
	reward_granted_at: string | null;
}

class ReferralInvalidCodeError extends Error {
	readonly code = "REFERRAL_INVALID_CODE";
	constructor() {
		super("Code de parrainage invalide");
		this.name = "ReferralInvalidCodeError";
	}
}

class ReferralSelfError extends Error {
	readonly code = "REFERRAL_SELF";
	constructor() {
		super("Impossible d'utiliser son propre code");
		this.name = "ReferralSelfError";
	}
}

class ReferralAlreadyReferredError extends Error {
	readonly code = "REFERRAL_ALREADY_REFERRED";
	constructor() {
		super("Ce compte a déjà été parrainé");
		this.name = "ReferralAlreadyReferredError";
	}
}

class ReferralCodeUsedError extends Error {
	readonly code = "REFERRAL_CODE_USED";
	constructor() {
		super("Ce code a déjà été utilisé");
		this.name = "ReferralCodeUsedError";
	}
}

// Génère le code au premier appel pour ce joueur (idempotent ensuite) — un
// INSERT en concurrence sur le même referrer_id échouerait sur la contrainte
// UNIQUE, on relit alors la ligne créée entre-temps par l'autre requête
// plutôt que de propager l'erreur.
const getOrCreateCode = async (userId: number): Promise<string> => {
	const [existingRows] = await db.query<ReferralRow[]>(
		"SELECT * FROM referrals WHERE referrer_id = ?",
		[userId],
	);
	if (existingRows[0]) return existingRows[0].code;

	for (let attempt = 0; attempt < 5; attempt++) {
		const code = generateCode();
		try {
			await db.query("INSERT INTO referrals (referrer_id, code) VALUES (?, ?)", [userId, code]);
			return code;
		} catch (error) {
			const mysqlError = error as { code?: string };
			if (mysqlError.code !== "ER_DUP_ENTRY") throw error;
			// Soit ce joueur a déjà une ligne créée par un appel concurrent (relire
			// et renvoyer son code), soit c'est le code généré qui collisionne avec
			// un autre parrain (retenter avec un nouveau code).
			const [rows] = await db.query<ReferralRow[]>(
				"SELECT * FROM referrals WHERE referrer_id = ?",
				[userId],
			);
			if (rows[0]) return rows[0].code;
		}
	}
	throw new Error("Impossible de générer un code de parrainage unique");
};

interface ReferralStatus {
	code: string;
	referred_username: string | null;
	status: "none" | "pending" | "completed";
	reward_granted: boolean;
}

const getStatus = async (userId: number): Promise<ReferralStatus> => {
	const code = await getOrCreateCode(userId);
	const [rows] = await db.query<(ReferralRow & { referred_username: string | null })[]>(
		`SELECT referrals.*, users.username AS referred_username
		 FROM referrals LEFT JOIN users ON users.id = referrals.referred_id
		 WHERE referrals.referrer_id = ?`,
		[userId],
	);
	const row = rows[0];
	if (!row || row.referred_id === null) {
		return { code, referred_username: null, status: "none", reward_granted: false };
	}
	return {
		code,
		referred_username: row.referred_username,
		status: row.completed_at !== null ? "completed" : "pending",
		reward_granted: row.reward_granted_at !== null,
	};
};

// Crédite le parrain (une seule fois, verrouillé par l'appelant — voir
// completeReferralIfPending/redeemCode ci-dessous, qui tiennent tous les deux
// déjà connection/la ligne verrouillée FOR UPDATE) et marque la ligne
// complétée. `row` doit déjà avoir completed_at éventuellement à poser.
const completeReferralRow = async (row: ReferralRow, connection: PoolConnection): Promise<void> => {
	if (row.completed_at === null) {
		await connection.query("UPDATE referrals SET completed_at = NOW() WHERE id = ?", [row.id]);
	}
	if (row.reward_granted_at === null) {
		await credit(row.referrer_id, REFERRAL_REWARD_GOLD, "referral_reward", String(row.id), connection);
		await creditFreePacks(row.referrer_id, REFERRAL_REWARD_PACKS, connection);
		await connection.query("UPDATE referrals SET reward_granted_at = NOW() WHERE id = ?", [row.id]);
	}
};

// Appelé par le FILLEUL pour entrer le code reçu de son parrain.
const redeemCode = async (referredUserId: number, code: string): Promise<void> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		const [referrerRows] = await connection.query<ReferralRow[]>(
			"SELECT * FROM referrals WHERE code = ? FOR UPDATE",
			[code],
		);
		const referrerRow = referrerRows[0];
		if (!referrerRow) throw new ReferralInvalidCodeError();
		if (referrerRow.referrer_id === referredUserId) throw new ReferralSelfError();
		if (referrerRow.referred_id !== null) throw new ReferralCodeUsedError();

		const [alreadyReferredRows] = await connection.query<ReferralRow[]>(
			"SELECT id FROM referrals WHERE referred_id = ? FOR UPDATE",
			[referredUserId],
		);
		if (alreadyReferredRows[0]) throw new ReferralAlreadyReferredError();

		await connection.query(
			"UPDATE referrals SET referred_id = ?, redeemed_at = NOW() WHERE id = ?",
			[referredUserId, referrerRow.id],
		);

		// Code entré après coup (le filleul avait déjà fini le tutoriel avant de
		// le renseigner) : compléter immédiatement plutôt que d'attendre un
		// claim-starter qui ne sera jamais rappelé pour ce compte.
		const [userRows] = await connection.query<(RowDataPacket & { starter_claimed_at: string | null })[]>(
			"SELECT starter_claimed_at FROM users WHERE id = ?",
			[referredUserId],
		);
		if (userRows[0] && userRows[0].starter_claimed_at !== null) {
			await completeReferralRow({ ...referrerRow, referred_id: referredUserId }, connection);
		}

		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Appelé depuis collectionController.claimStarter (fin de tutoriel), dans la
// même transaction que le reste de claim-starter — no-op si ce joueur n'a
// jamais été parrainé ou si son parrainage est déjà complété.
const completeReferralIfPending = async (referredUserId: number, connection: PoolConnection): Promise<void> => {
	const [rows] = await connection.query<ReferralRow[]>(
		"SELECT * FROM referrals WHERE referred_id = ? AND completed_at IS NULL FOR UPDATE",
		[referredUserId],
	);
	const row = rows[0];
	if (!row) return;
	await completeReferralRow(row, connection);
};

export {
	REFERRAL_REWARD_GOLD,
	REFERRAL_REWARD_PACKS,
	ReferralInvalidCodeError,
	ReferralSelfError,
	ReferralAlreadyReferredError,
	ReferralCodeUsedError,
	getOrCreateCode,
	getStatus,
	redeemCode,
	completeReferralIfPending,
};
