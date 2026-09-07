import { Request, Response, NextFunction } from "express";
import type { JwtPayload } from "jsonwebtoken";

// Limiteur de débit minimal, en mémoire (pas de dépendance externe) : borne le
// nombre d'appels par fenêtre glissante pour une clé donnée (par défaut,
// l'utilisateur authentifié — voir middleware/auth.ts — avec repli sur l'IP
// pour les routes publiques). Suffisant pour un seul processus API derrière
// Nginx (voir CLAUDE.md « Infra & déploiement ») ; à revoir (store partagé,
// type Redis) si l'API est un jour répartie sur plusieurs instances.
interface Bucket {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Purge périodique pour ne pas laisser grossir indéfiniment la Map avec des
// clés expirées (utilisateurs/IPs inactifs).
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
	const now = Date.now();
	for (const [key, bucket] of buckets) {
		if (bucket.resetAt <= now) buckets.delete(key);
	}
}, SWEEP_INTERVAL_MS).unref();

const defaultKeyBy = (req: Request): string => {
	const payload = req.user as JwtPayload | undefined;
	if (payload && typeof payload.id !== "undefined") return `user:${payload.id}`;
	return `ip:${req.ip}`;
};

interface RateLimitOptions {
	windowMs: number;
	max: number;
	// Préfixe distinct par route montée sur ce middleware, pour que deux routes
	// différentes ne partagent pas accidentellement le même compteur.
	name: string;
	keyBy?: (req: Request) => string;
}

const rateLimit = ({ windowMs, max, name, keyBy = defaultKeyBy }: RateLimitOptions) => {
	return (req: Request, res: Response, next: NextFunction): void => {
		const key = `${name}:${keyBy(req)}`;
		const now = Date.now();
		const existing = buckets.get(key);

		if (!existing || existing.resetAt <= now) {
			buckets.set(key, { count: 1, resetAt: now + windowMs });
			next();
			return;
		}

		if (existing.count >= max) {
			res.status(429).json({ message: "Trop de requêtes, réessaie plus tard" });
			return;
		}

		existing.count += 1;
		next();
	};
};

export default rateLimit;
