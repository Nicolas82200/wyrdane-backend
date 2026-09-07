import type { RowDataPacket } from "mysql2";
import db from "./db";

interface UsernameRow extends RowDataPacket {
	username: string;
}

const findUsername = async (userId: number): Promise<string | null> => {
	const [rows] = await db.query<UsernameRow[]>(
		"SELECT username FROM users WHERE id = ?",
		[userId],
	);
	return rows[0]?.username ?? null;
};

export { findUsername };
