// Wrapper de confirmation pour reset-players.sql : vide la table `users`
// (et tout ce qui en cascade, voir reset-players.sql) en PRODUCTION. Ce
// script est irréversible sans backup préalable — jusqu'ici reset-players.sql
// ne pouvait être lancé qu'à la main (`mysql ... < reset-players.sql`), sans
// aucun garde-fou technique contre une exécution malencontreuse. Ce wrapper
// impose une confirmation explicite avant toute suppression.
//
// Usage : npm run db:reset-players -- --confirm-wipe-players
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = process.env;

const SQL_PATH = join(__dirname, "reset-players.sql");

const main = async (): Promise<void> => {
	if (!process.argv.includes("--confirm-wipe-players")) {
		console.error(
			"Refus d'exécuter reset-players.sql sans confirmation explicite : ce script supprime " +
				"TOUS les joueurs (et tout ce qui en dépend en cascade) de la base ciblée par ton .env.\n" +
				`Base ciblée : ${DB_HOST ?? "?"}/${DB_NAME ?? "?"}\n` +
				"Fais un dump avant si un doute existe (voir en-tête de reset-players.sql), puis relance avec --confirm-wipe-players.",
		);
		process.exit(1);
	}

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
		console.log(`→ Suppression de tous les joueurs (${DB_HOST}/${DB_NAME})...`);
		await connection.query(readFileSync(SQL_PATH, "utf8"));
		console.log("✓ Terminé.");
	} finally {
		await connection.end();
	}
};

main().catch((error) => {
	console.error("Échec du reset :", error);
	process.exit(1);
});
