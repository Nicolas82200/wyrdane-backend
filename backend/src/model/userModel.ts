import { RowDataPacket, ResultSetHeader } from "mysql2";
import type { PoolConnection } from "mysql2/promise";

import db from "./db";
import { User } from "../types";
import { STARTER_CURRENCY } from "./currencyModel";

interface UserRow extends User, RowDataPacket {}

const findOne = async (id: number): Promise<UserRow[]> => {
	const [rows] = await db.query<UserRow[]>(
		"SELECT id, username, created_at FROM `users` WHERE id = ?",
		[id],
	);
	return rows;
};

const findBySteamId = async (steamId: string): Promise<UserRow[]> => {
	const [rows] = await db.query<UserRow[]>(
		`SELECT users.id, users.username, users.created_at
		 FROM users
		 JOIN linked_accounts ON linked_accounts.user_id = users.id
		 WHERE linked_accounts.provider = 'steam' AND linked_accounts.external_id = ?`,
		[steamId],
	);
	return rows;
};

// Crée le joueur ET son compte Steam lié en une seule transaction : les deux
// lignes doivent exister ensemble, sinon un joueur sans identité liée resterait
// inatteignable au prochain login.
const createWithSteamAccount = async (
	username: string,
	steamId: string,
): Promise<{ id: number; username: string }> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		// Solde de départ accordé explicitement (plutôt que de compter sur le
		// défaut de colonne, qui reste à 0) : les comptes créés avant l'ajout de
		// ce bonus le reçoivent séparément via claimStarterBonus (voir plus bas).
		const [userResult] = await connection.query<ResultSetHeader>(
			"INSERT INTO `users` (username, soft_currency) VALUES (?, ?)",
			[username, STARTER_CURRENCY],
		);
		const userId = userResult.insertId;

		await connection.query(
			"INSERT INTO `linked_accounts` (user_id, provider, external_id) VALUES (?, 'steam', ?)",
			[userId, steamId],
		);

		await connection.commit();
		return { id: userId, username };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Voir POST /api/collection/claim-starter : empêche de regrant/recréer les
// decks de départ si le joueur (ou le client, en cas de retry réseau) rappelle
// la route après une première réclamation réussie.
const hasClaimedStarter = async (userId: number): Promise<boolean> => {
	const [rows] = await db.query<(RowDataPacket & { starter_claimed_at: string | null })[]>(
		"SELECT starter_claimed_at FROM `users` WHERE id = ?",
		[userId],
	);
	return rows.length > 0 && rows[0].starter_claimed_at !== null;
};

const markStarterClaimed = async (userId: number, connection?: PoolConnection): Promise<void> => {
	const runner = connection ?? db;
	await runner.query("UPDATE `users` SET starter_claimed_at = NOW() WHERE id = ?", [userId]);
};

export { findOne, findBySteamId, createWithSteamAccount, hasClaimedStarter, markStarterClaimed };
