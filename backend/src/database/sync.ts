// Contrepartie non destructive de migrate.ts : applique schema_sync.sql
// (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS partout, aucun DROP)
// contre une base déjà en service, sans perte de données. À utiliser en prod
// pour rattraper un schéma en retard sur schema.sql — migrate.ts reste
// réservé au dev/CI (il DROP + recrée tout).
//
// Usage : npm run db:sync
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = process.env;

const SCHEMA_SYNC_PATH = join(__dirname, "schema_sync.sql");

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
