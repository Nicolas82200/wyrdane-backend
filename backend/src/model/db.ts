import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

// Un pool : un ensemble de connexions réutilisables vers la base
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT ? Number(DB_PORT) : undefined,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
});

export default pool;
