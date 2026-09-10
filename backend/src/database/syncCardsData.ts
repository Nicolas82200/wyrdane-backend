// Contrepartie non destructive de migrate.ts pour la table `cards` : au lieu
// de DROP + réimporter cards_data.sql (destructeur, dev/CI uniquement — voir
// migrate.ts), ce script met à jour les lignes existantes en place (UPDATE
// par `name`, la clé de correspondance jeu↔backend, voir CLAUDE.md
// "Lien carte client↔backend = nom FR exact") et insère les cartes nouvelles.
// Sûr à rejouer contre une base déjà en service, y compris la prod.
//
// Ne supprime JAMAIS de ligne : `cards.id` est référencé par `user_cards`/
// `deck_cards` en ON DELETE CASCADE, donc une suppression effacerait la
// collection/les decks des joueurs qui possèdent cette carte. Un renommage
// commande une correspondance ambiguë) sont uniquement listées à la fin
// pour revue manuelle.
//
// Usage : npm run db:sync-cards (relit cards_data.sql, généré par
// generate-cards-data.mjs — régénérer ce fichier d'abord si le jeu a changé)
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = process.env;

const CARDS_DATA_PATH = join(__dirname, "cards_data.sql");

type CardRow = {
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

function parseCardsDataSql(sql: string): CardRow[] {
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

const main = async (): Promise<void> => {
	const freshRows = parseCardsDataSql(readFileSync(CARDS_DATA_PATH, "utf8"));
	console.log(`→ ${freshRows.length} cartes lues depuis cards_data.sql`);

	const connection = await mysql.createConnection({
		host: DB_HOST,
		port: DB_PORT ? Number(DB_PORT) : undefined,
		user: DB_USER,
		password: DB_PASSWORD,
		database: DB_NAME,
		charset: "utf8mb4",
		ssl: DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
	});

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

	console.log(`✓ ${updated} cartes mises à jour, ${created} nouvelles cartes créées`);
	if (orphaned.length > 0) {
		console.log(
			`⚠ ${orphaned.length} carte(s) en base absente(s) du jeu actuel (non supprimées, à vérifier manuellement — renommage ou retrait réel ?) :`,
		);
		for (const name of orphaned) console.log(`  - ${name}`);
	}

	await connection.end();
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
