import type { RowDataPacket } from "mysql2";
import db from "./db";

// Enregistre une vue de page anonyme (voir POST /api/analytics/pageview,
// public). visitorId vient d'un cookie non-auth posé par le controller à la
// première visite — permet de distinguer visites totales et visiteurs
// uniques approximatifs dans le dashboard admin.
const recordVisit = async (visitorId: string, path: string): Promise<void> => {
	await db.query("INSERT INTO site_visits (visitor_id, path) VALUES (?, ?)", [visitorId, path]);
};

// Enregistre une connexion Steam réussie, taguée par origine ('site' ou
// 'game') — voir authController.loginWithSteamId, appelé pour CHAQUE
// connexion (pas seulement la première, contrairement à users.created_at).
const recordLogin = async (userId: number, source: "site" | "game"): Promise<void> => {
	await db.query("INSERT INTO login_events (user_id, source) VALUES (?, ?)", [userId, source]);
};

const getWishlistCount = async (): Promise<number> => {
	const [rows] = await db.query<(RowDataPacket & { count: number })[]>(
		"SELECT count FROM wishlist_stats WHERE id = 1",
	);
	return rows[0]?.count ?? 0;
};

const setWishlistCount = async (count: number): Promise<void> => {
	await db.query("UPDATE wishlist_stats SET count = ? WHERE id = 1", [count]);
};

interface Stats {
	totalVisits: number;
	uniqueVisitors: number;
	siteLogins: number;
	gameLogins: number;
	uniqueLoginUsers: number;
	wishlistCount: number;
}

// Agrège les chiffres affichés par le dashboard admin. Pas de fenêtre de temps
// (cumul total depuis la mise en place du tracking) — suffisant pour un
// premier tableau de bord ; à affiner (par jour/semaine) si besoin plus tard.
const getStats = async (): Promise<Stats> => {
	const [[visitRow]] = await db.query<(RowDataPacket & { total: number; unique_visitors: number })[]>(
		"SELECT COUNT(*) AS total, COUNT(DISTINCT visitor_id) AS unique_visitors FROM site_visits",
	);
	const [[loginRow]] = await db.query<
		(RowDataPacket & { site_logins: number; game_logins: number; unique_login_users: number })[]
	>(
		`SELECT
			SUM(CASE WHEN source = 'site' THEN 1 ELSE 0 END) AS site_logins,
			SUM(CASE WHEN source = 'game' THEN 1 ELSE 0 END) AS game_logins,
			COUNT(DISTINCT user_id) AS unique_login_users
		 FROM login_events`,
	);
	const wishlistCount = await getWishlistCount();

	return {
		totalVisits: visitRow?.total ?? 0,
		uniqueVisitors: visitRow?.unique_visitors ?? 0,
		siteLogins: loginRow?.site_logins ?? 0,
		gameLogins: loginRow?.game_logins ?? 0,
		uniqueLoginUsers: loginRow?.unique_login_users ?? 0,
		wishlistCount,
	};
};

export { recordVisit, recordLogin, getWishlistCount, setWishlistCount, getStats };
