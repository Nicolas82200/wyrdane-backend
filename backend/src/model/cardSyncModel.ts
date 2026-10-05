// Logique partagée entre le script CLI (database/syncCardsData.ts) et la
// route admin (POST /api/admin/sync-cards) : UPDATE par `name` pour les
// cartes existantes, INSERT pour les nouvelles, ne supprime JAMAIS de ligne
// (voir l'en-tête de syncCardsData.ts pour le détail et les garanties).
import { readFileSync } from "fs";
import mysql from "mysql2/promise";

import pool from "./db";

export type CardRow = {
	name: string;
	race: string;
	card_type: string;
	lane: string | null;
	cost: number | null;
	attack: number | null;
	hp: number | null;
	rarity: string | null;
	charges: number | null;
	effect: string | null;
	flavor: string | null;
	image_path: string | null;
};

export type SyncResult = {
	totalRead: number;
	updated: number;
	created: number;
	orphaned: string[];
};

const COLUMNS: (keyof CardRow)[] = [
	"name",
	"race",
	"card_type",
	"lane",
	"cost",
	"attack",
	"hp",
	"rarity",
	"charges",
	"effect",
	"flavor",
	"image_path",
];

// Découpe la liste d'arguments d'un INSERT (...) en respectant les chaînes
// entre quotes SQL simples, où '' est l'échappement d'un guillemet littéral.
function splitSqlValues(inner: string): string[] {
	const values: string[] = [];
	let i = 0;
	while (i < inner.length) {
		while (i < inner.length && /\s/.test(inner[i])) i++;
		if (i >= inner.length) break;
		if (inner[i] === ",") {
			i++;
			continue;
		}
		if (inner[i] === "'") {
			let out = "";
			i++;
			while (i < inner.length) {
				if (inner[i] === "'" && inner[i + 1] === "'") {
					out += "'";
					i += 2;
					continue;
				}
				if (inner[i] === "'") {
					i++;
					break;
				}
				out += inner[i];
				i++;
			}
			values.push(out);
		} else {
			let out = "";
			while (i < inner.length && inner[i] !== ",") {
				out += inner[i];
				i++;
			}
			values.push(out.trim());
		}
	}
	return values;
}

export function parseCardsDataSql(sql: string): CardRow[] {
	const rows: CardRow[] = [];
	const re = /INSERT INTO cards \([^)]*\) VALUES \(([\s\S]*?)\);\n/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql))) {
		const parts = splitSqlValues(m[1]);
		if (parts.length !== COLUMNS.length) {
			throw new Error(`Unexpected column count (${parts.length}) in row: ${m[1].slice(0, 80)}...`);
		}
		const toNullableString = (v: string) => (v === "NULL" ? null : v);
		const toNullableInt = (v: string) => (v === "NULL" ? null : Number(v));
		rows.push({
			name: parts[0],
			race: parts[1],
			card_type: parts[2],
			lane: toNullableString(parts[3]),
			cost: toNullableInt(parts[4]),
			attack: toNullableInt(parts[5]),
			hp: toNullableInt(parts[6]),
			rarity: toNullableString(parts[7]),
			charges: toNullableInt(parts[8]),
			effect: toNullableString(parts[9]),
			flavor: toNullableString(parts[10]),
			image_path: toNullableString(parts[11]),
		});
	}
	return rows;
}

// `connection` : une connexion dédiée (CLI, voir syncCardsData.ts) ou une
// connexion empruntée au pool partagé (route admin, le pool de ../model/db
// reste libre pour le reste du serveur pendant la transaction).
export async function syncCardsFromSql(
	sql: string,
	connection: mysql.Connection | mysql.PoolConnection,
): Promise<SyncResult> {
	const freshRows = parseCardsDataSql(sql);

	const [existingRows] = await connection.query<mysql.RowDataPacket[]>("SELECT name FROM cards");
	const existingNames = new Set(existingRows.map((r) => r.name as string));
	const freshNames = new Set(freshRows.map((r) => r.name));

	let created = 0;
	let updated = 0;

	await connection.beginTransaction();
	try {
		for (const row of freshRows) {
			const values = COLUMNS.map((c) => row[c]);
			if (existingNames.has(row.name)) {
				const setClause = COLUMNS.filter((c) => c !== "name")
					.map((c) => `${c} = ?`)
					.join(", ");
				const updateValues = COLUMNS.filter((c) => c !== "name").map((c) => row[c]);
				await connection.query(`UPDATE cards SET ${setClause} WHERE name = ?`, [...updateValues, row.name]);
				updated++;
			} else {
				const placeholders = COLUMNS.map(() => "?").join(", ");
				await connection.query(`INSERT INTO cards (${COLUMNS.join(", ")}) VALUES (${placeholders})`, values);
				created++;
			}
		}
		await connection.commit();
	} catch (err) {
		await connection.rollback();
		throw err;
	}

	const orphaned = [...existingNames].filter((n) => !freshNames.has(n));

	return { totalRead: freshRows.length, updated, created, orphaned };
}

// Lit cards_data.sql depuis le chemin donné et applique syncCardsFromSql en
// emprûntant une connexion au pool partagé (route admin) — toujours relâchée.
export async function syncCardsFromFile(cardsDataPath: string): Promise<SyncResult> {
	const sql = readFileSync(cardsDataPath, "utf8");
	const connection = await pool.getConnection();
	try {
		return await syncCardsFromSql(sql, connection);
	} finally {
		connection.release();
	}
}
