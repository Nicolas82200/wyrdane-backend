import type { Request, Response } from "express";
import { readSystemStatus } from "../model/systemStatusModel";
import pool from "../model/db";

// Au-delà de ce délai, la dernière sauvegarde réussie est considérée périmée.
// 36 h et non 24 : le cron tourne à 3h05, donc un écart légitime de 24 h + le
// temps d'exécution est normal, et un seuil à 24 h sonnerait tous les matins.
const BACKUP_STALE_AFTER_HOURS = 36;

// Deux niveaux de réponse dans une seule route :
//
//   - sans en-tête `x-health-key`, on ne renvoie que de quoi répondre à un
//     moniteur de disponibilité : le service est-il debout, la base
//     répond-elle. C'est tout ce dont UptimeRobot a besoin, et c'est public.
//   - avec la bonne clé (bot Discord, administration), on ajoute le détail
//     opérationnel : fraîcheur de la dernière sauvegarde. Ce n'est pas un
//     secret grave, mais « les sauvegardes sont mortes depuis 5 jours » est
//     précisément le genre d'information qui renseigne qui ne devrait pas.
//
// Le code HTTP reste 200 tant que l'API répond : un 503 ferait crier le
// moniteur pour une sauvegarde en retard, alors que le service, lui, va bien.
// Seule une base injoignable renvoie 503, parce que là le jeu est hors service.
export const getHealth = async (req: Request, res: Response): Promise<void> => {
	let dbUp = false;
	try {
		await pool.query("SELECT 1");
		dbUp = true;
	} catch {
		dbUp = false;
	}

	const body: Record<string, unknown> = { ok: dbUp, db: dbUp ? "up" : "down" };

	const key = process.env.HEALTH_KEY;
	const authorized = Boolean(key) && req.get("x-health-key") === key;

	if (authorized) {
		let lastBackupAt: string | null = null;
		try {
			lastBackupAt = await readSystemStatus("last_backup_at");
		} catch {
			lastBackupAt = null;
		}

		const ageHours =
			lastBackupAt === null ? null : (Date.now() - new Date(lastBackupAt).getTime()) / 3_600_000;

		body.backup = {
			lastAt: lastBackupAt,
			ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
			// null (jamais de sauvegarde enregistrée) compte comme périmé : c'est
			// le cas qu'on veut voir remonter, pas celui qu'on veut passer sous
			// silence parce que la donnée manque.
			stale: ageHours === null || ageHours > BACKUP_STALE_AFTER_HOURS,
		};
	}

	res.status(dbUp ? 200 : 503).json(body);
};
