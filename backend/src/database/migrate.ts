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

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD } = process.env;

const SCHEMA_PATH = join(__dirname, "schema.sql");
const CARDS_DATA_PATH = join(__dirname, "cards_data.sql");

const runSqlFile = async (connection: mysql.Connection, label: string, path: string): Promise<void> => {
	console.log(`→ ${label}...`);
	const sql = readFileSync(path, "utf8");
	await connection.query(sql);
	console.log(`✓ ${label} terminé`);
};

const main = async (): Promise<void> => {
	// Pas de DB_NAME ici : schema.sql fait lui-même le DROP/CREATE DATABASE,
	// donc la connexion initiale ne doit pas cibler une base précise.
	const connection = await mysql.createConnection({
		host: DB_HOST,
		port: DB_PORT ? Number(DB_PORT) : undefined,
		user: DB_USER,
		password: DB_PASSWORD,
		multipleStatements: true,
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
