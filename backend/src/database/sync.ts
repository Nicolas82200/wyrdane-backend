// Contrepartie non destructive de migrate.ts : applique schema_sync.sql
// (CREATE TABLE IF NOT EXISTS partout, aucun DROP) puis ajoute les colonnes
// manquantes sur `users` une par une (vérifiées via information_schema —
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS n'est pas supporté par toutes les
// versions de MySQL/MariaDB, d'où cette vérification manuelle plutôt que de
// compter sur la syntaxe SQL). Sûr à rejouer contre une base déjà en service,
// y compris déjà à jour. migrate.ts reste réservé au dev/CI (il DROP + recrée
// tout).
//
// Usage : npm run db:sync
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = process.env;

const SCHEMA_SYNC_PATH = join(__dirname, "schema_sync.sql");

// Colonnes ajoutées à `users` après sa création initiale (monnaie molle,
// bonus de départ) — voir schema.sql pour la définition de référence.
const USERS_COLUMNS_TO_ENSURE: { name: string; ddl: string }[] = [
	{ name: "soft_currency", ddl: "soft_currency INT NOT NULL DEFAULT 0" },
	{ name: "starter_claimed_at", ddl: "starter_claimed_at TIMESTAMP NULL DEFAULT NULL" },
	{ name: "starter_currency_claimed_at", ddl: "starter_currency_claimed_at TIMESTAMP NULL DEFAULT NULL" },
];

const ensureUsersColumns = async (connection: mysql.Connection): Promise<void> => {
	const [rows] = await connection.query<mysql.RowDataPacket[]>(
		"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'",
		[DB_NAME],
	);
	const existing = new Set(rows.map((row) => row.COLUMN_NAME as string));

	for (const column of USERS_COLUMNS_TO_ENSURE) {
		if (existing.has(column.name)) continue;
		console.log(`→ Ajout de la colonne users.${column.name}...`);
		await connection.query(`ALTER TABLE users ADD COLUMN ${column.ddl}`);
	}
};

const main = async (): Promise<void> => {
	const connection = await mysql.createConnection({
		host: DB_HOST,
		port: DB_PORT ? Number(DB_PORT) : undefined,
		user: DB_USER,
		password: DB_PASSWORD,
		database: DB_NAME,
		multipleStatements: true,
		ssl: DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
	});

	try {
		console.log("→ Synchronisation additive du schéma...");
		await ensureUsersColumns(connection);
		const sql = readFileSync(SCHEMA_SYNC_PATH, "utf8");
		await connection.query(sql);
		console.log("✓ Schéma à jour, aucune donnée existante affectée.");
	} finally {
		await connection.end();
	}
};

main().catch((error) => {
	console.error("Échec de la synchronisation :", error);
	process.exit(1);
});
