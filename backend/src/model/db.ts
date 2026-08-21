import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = process.env;

// Un pool : un ensemble de connexions réutilisables vers la base
// DB_SSL=true : requis pour les MySQL managés (ex. Aiven) qui exigent TLS,
// inutile contre une instance locale.
// charset explicite : le serveur MySQL du VPS a `character_set_client`
// par défaut sur latin1 (négocié côté client faute de locale dans le
// conteneur, alors que la colonne est bien en utf8mb4) — sans ce réglage,
// tout accent envoyé/lu par le pool risque le même mojibake ("Ã©") qui a
// dû être corrigé manuellement sur `cards` début 2026-08. mysql2 accepte
// l'alias "utf8mb4" (mappé sur sa collation par défaut).
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT ? Number(DB_PORT) : undefined,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  charset: "utf8mb4",
  ssl: DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export default pool;
