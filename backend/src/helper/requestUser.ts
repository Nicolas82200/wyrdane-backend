import type { Request } from "express";
import type { JwtPayload } from "jsonwebtoken";

// Extrait l'id utilisateur du payload JWT posé par le middleware
// d'autorisation (req.user, voir middleware/auth.ts). Partagé par tous les
// controllers protégés plutôt que redéfini localement dans chacun.
const getUserId = (req: Request): number | null => {
	const payload = req.user as JwtPayload | undefined;
	if (!payload || typeof payload.id === "undefined") return null;
	const id = Number(payload.id);
	return Number.isNaN(id) ? null : id;
};

export { getUserId };
