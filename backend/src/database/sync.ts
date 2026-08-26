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
	{ name: "first_login_reward_claimed_at", ddl: "first_login_reward_claimed_at TIMESTAMP NULL DEFAULT NULL" },
	{ name: "is_admin", ddl: "is_admin BOOLEAN NOT NULL DEFAULT FALSE" },
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

// win_streak ajoutée à solo_stats après sa création initiale (voir
// schema.sql) — même pattern que ensureUsersColumns, sur une table distincte.
const SOLO_STATS_COLUMNS_TO_ENSURE: { name: string; ddl: string }[] = [
	{ name: "win_streak", ddl: "win_streak INT NOT NULL DEFAULT 0" },
];

const ensureSoloStatsColumns = async (connection: mysql.Connection): Promise<void> => {
	const [rows] = await connection.query<mysql.RowDataPacket[]>(
		"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'solo_stats'",
		[DB_NAME],
	);
	const existing = new Set(rows.map((row) => row.COLUMN_NAME as string));

	for (const column of SOLO_STATS_COLUMNS_TO_ENSURE) {
		if (existing.has(column.name)) continue;
		console.log(`→ Ajout de la colonne solo_stats.${column.name}...`);
		await connection.query(`ALTER TABLE solo_stats ADD COLUMN ${column.ddl}`);
	}
};

// win_streak ajoutée à ranked_stats après sa création initiale (voir
// schema.sql) — même pattern que ensureSoloStatsColumns.
const RANKED_STATS_COLUMNS_TO_ENSURE: { name: string; ddl: string }[] = [
	{ name: "win_streak", ddl: "win_streak INT NOT NULL DEFAULT 0" },
];

const ensureRankedStatsColumns = async (connection: mysql.Connection): Promise<void> => {
	const [rows] = await connection.query<mysql.RowDataPacket[]>(
		"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'ranked_stats'",
		[DB_NAME],
	);
	const existing = new Set(rows.map((row) => row.COLUMN_NAME as string));

	for (const column of RANKED_STATS_COLUMNS_TO_ENSURE) {
		if (existing.has(column.name)) continue;
		console.log(`→ Ajout de la colonne ranked_stats.${column.name}...`);
		await connection.query(`ALTER TABLE ranked_stats ADD COLUMN ${column.ddl}`);
	}
};

// username n'a plus vocation à être unique (voir schema.sql) : c'est
// désormais le pseudo Steam affiché, que plusieurs joueurs peuvent partager.
// Un index inline UNIQUE ancien est nommé comme la colonne par défaut en
// MySQL/MariaDB ("username") : vérifié via information_schema avant de le
// supprimer pour rester rejouable sans erreur sur une base déjà à jour.
const dropUsernameUniqueIndex = async (connection: mysql.Connection): Promise<void> => {
	const [rows] = await connection.query<mysql.RowDataPacket[]>(
		`SELECT INDEX_NAME FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND INDEX_NAME = 'username'`,
		[DB_NAME],
	);
	if (rows.length === 0) return;
	console.log("→ Suppression de la contrainte UNIQUE sur users.username...");
	await connection.query("ALTER TABLE users DROP INDEX username");
};

// cards_played_by_race/deck_races ajoutées à match_reports après sa création
// initiale (voir schema.sql) — même pattern que ensureSoloStatsColumns.
const MATCH_REPORTS_COLUMNS_TO_ENSURE: { name: string; ddl: string }[] = [
	{ name: "cards_played_by_race", ddl: "cards_played_by_race JSON NULL" },
	{ name: "deck_races", ddl: "deck_races JSON NULL" },
];

const ensureMatchReportsColumns = async (connection: mysql.Connection): Promise<void> => {
	const [rows] = await connection.query<mysql.RowDataPacket[]>(
		"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'match_reports'",
		[DB_NAME],
	);
	const existing = new Set(rows.map((row) => row.COLUMN_NAME as string));

	for (const column of MATCH_REPORTS_COLUMNS_TO_ENSURE) {
		if (existing.has(column.name)) continue;
		console.log(`→ Ajout de la colonne match_reports.${column.name}...`);
		await connection.query(`ALTER TABLE match_reports ADD COLUMN ${column.ddl}`);
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
		charset: "utf8mb4",
		ssl: DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
	});

	try {
		console.log("→ Synchronisation additive du schéma...");
		await ensureUsersColumns(connection);
		await dropUsernameUniqueIndex(connection);
		const sql = readFileSync(SCHEMA_SYNC_PATH, "utf8");
		await connection.query(sql);
		// Après le CREATE TABLE IF NOT EXISTS ci-dessus : ranked_stats/solo_stats/
		// match_reports sont garanties d'exister avant qu'on tente d'y ajouter une colonne.
		await ensureRankedStatsColumns(connection);
		await ensureSoloStatsColumns(connection);
		await ensureMatchReportsColumns(connection);
		console.log("✓ Schéma à jour, aucune donnée existante affectée.");
	} finally {
		await connection.end();
	}
};

main().catch((error) => {
	console.error("Échec de la synchronisation :", error);
	process.exit(1);
});
