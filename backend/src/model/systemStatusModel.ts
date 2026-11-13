import type { RowDataPacket } from "mysql2/promise";
import pool from "./db";

// Petite table clé/valeur pour l'état d'exploitation, écrite depuis l'extérieur
// de l'application (scripts/backup-db.sh y pose `last_backup_at`) et lue par la
// route de santé.
//
// Pourquoi la base plutôt qu'un fichier : le script de sauvegarde tourne sur
// l'hôte, l'API dans un conteneur, et aucun volume n'est partagé entre les
// deux. La base est le seul endroit que les deux atteignent déjà, sans ajouter
// de montage ni toucher au docker-compose.
export const readSystemStatus = async (key: string): Promise<string | null> => {
	const [rows] = await pool.query<RowDataPacket[]>(
		"SELECT value FROM system_status WHERE `key` = ? LIMIT 1",
		[key],
	);
	return rows.length > 0 ? String(rows[0].value) : null;
};
