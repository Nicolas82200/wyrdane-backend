import { Request, Response, NextFunction } from "express";
import type { RowDataPacket } from "mysql2";

import db from "../model/db";
import { getUserId } from "../helper/requestUser";

// À placer APRÈS `authorization` (a besoin de req.user). Revérifie le rôle en
// base à chaque requête plutôt que de faire confiance à un flag embarqué dans
// le JWT : le cookie de session reste valide jusqu'à 1h (voir jwtHelper), un
// retrait de droit admin doit prendre effet immédiatement.
const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const [rows] = await db.query<(RowDataPacket & { is_admin: number })[]>(
			"SELECT is_admin FROM users WHERE id = ?",
			[userId],
		);
		if (!rows[0]?.is_admin) {
			res.status(403).json({ message: "Accès réservé aux administrateurs" });
			return;
		}

		next();
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export default requireAdmin;
