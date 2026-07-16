import { RowDataPacket, ResultSetHeader } from "mysql2";

import db from "./db";
import { User } from "../types";

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

		const [userResult] = await connection.query<ResultSetHeader>(
			"INSERT INTO `users` (username) VALUES (?)",
			[username],
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

export { findOne, findBySteamId, createWithSteamAccount };
