import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = process.env;

// Un pool : un ensemble de connexions réutilisables vers la base
// DB_SSL=true : requis pour les MySQL managés (ex. Aiven) qui exigent TLS,
// inutile contre une instance locale.
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT ? Number(DB_PORT) : undefined,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  ssl: DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export default pool;
