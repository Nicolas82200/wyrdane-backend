// Script de (ré)initialisation de la base : recrée le schéma depuis zéro puis
// réimporte le catalogue de cartes. Pas d'outil de migration incrémentale
// pour l'instant (voir schema.sql, qui DROP + recrée toutes les tables) :
// ce script est donc destructeur, à réserver au dev/CI, jamais à la prod.
//
// Usage : npm run db:migrate
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_SSL } = process.env;

const SCHEMA_PATH = join(__dirname, "schema.sql");
const CARDS_DATA_PATH = join(__dirname, "cards_data.sql");

const runSqlFile = async (connection: mysql.Connection, label: string, path: string): Promise<void> => {
	console.log(`→ ${label}...`);
	const sql = readFileSync(path, "utf8");
	await connection.query(sql);
	console.log(`✓ ${label} terminé`);
};

const main = async (): Promise<void> => {
	// Garde technique : ce script DROP + recrée tout le schéma, réservé au
	// dev/CI (voir en-tête). Un lancement accidentel en prod (mauvais .env,
	// mauvaise machine) effacerait toutes les données joueurs sans recours.
	if (process.env.NODE_ENV === "production" && !process.argv.includes("--confirm-prod-wipe")) {
		console.error(
			"Refus d'exécuter db:migrate avec NODE_ENV=production : ce script DROP toute la base.\n" +
				"Si c'est réellement voulu, relance avec --confirm-prod-wipe.",
		);
		process.exit(1);
	}

	// Pas de DB_NAME ici : schema.sql fait lui-même le DROP/CREATE DATABASE,
	// donc la connexion initiale ne doit pas cibler une base précise.
	const connection = await mysql.createConnection({
		host: DB_HOST,
		port: DB_PORT ? Number(DB_PORT) : undefined,
		user: DB_USER,
		password: DB_PASSWORD,
		multipleStatements: true,
		charset: "utf8mb4",
		ssl: DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
	});

	try {
		await runSqlFile(connection, "Recréation du schéma (DROP + CREATE)", SCHEMA_PATH);
		await runSqlFile(connection, "Import du catalogue de cartes", CARDS_DATA_PATH);
		console.log("Base de données réinitialisée avec succès.");
	} finally {
		await connection.end();
	}
};

main().catch((error) => {
	console.error("Échec de la migration :", error);
	process.exit(1);
});
