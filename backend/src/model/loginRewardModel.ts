import type { RowDataPacket } from "mysql2";
import type { Pool, PoolConnection } from "mysql2/promise";
import db from "./db";
import { credit, getBalance } from "./currencyModel";

class AlreadyClaimedTodayError extends Error {
	constructor() {
		super("Récompense de connexion déjà réclamée aujourd'hui");
		this.name = "AlreadyClaimedTodayError";
	}
}

// Récompense croissante sur 7 jours de connexion consécutifs, puis la série
// reboucle (jour 8 = jour 1) — voir rewardForDay. Un jour manqué reset le
// PALIER de récompense à 1, mais streak_day en base continue de compter le
// nombre total de jours consécutifs (pas plafonné à 7) : simple compteur de
// série affiché tel quel, la récompense elle-même est dérivée modulo 7.
const REWARD_BY_DAY = [10, 15, 20, 25, 30, 40, 60];

const rewardForDay = (day: number): number => REWARD_BY_DAY[(day - 1) % REWARD_BY_DAY.length];

interface LoginRewardRow extends RowDataPacket {
	user_id: number;
	streak_day: number;
	last_claimed_date: string | null;
	claimed_today: number; // 0/1 (NULL-safe : false si jamais réclamé)
	is_consecutive: number; // 0/1 : dernière réclamation = hier
}

const ensureRow = async (userId: number, connection?: PoolConnection): Promise<void> => {
	const runner: Pool | PoolConnection = connection ?? db;
	await runner.query(
		"INSERT INTO login_rewards (user_id, streak_day, last_claimed_date) VALUES (?, 0, NULL) ON DUPLICATE KEY UPDATE user_id = user_id",
		[userId],
	);
};

// claimed_today/is_consecutive calculés côté SQL (CURDATE(), horloge serveur)
// plutôt qu'en comparant des dates en JS : évite tout écart de fuseau horaire
// entre l'app et la base. FOR UPDATE optionnel : verrouille la ligne quand un
// appelant transactionnel (claim) le demande, lecture simple sinon (status).
const fetchRow = async (userId: number, connection?: PoolConnection): Promise<LoginRewardRow> => {
	const runner: Pool | PoolConnection = connection ?? db;
	const [rows] = await runner.query<LoginRewardRow[]>(
		`SELECT user_id, streak_day, last_claimed_date,
		   (last_claimed_date = CURDATE()) AS claimed_today,
		   (last_claimed_date = CURDATE() - INTERVAL 1 DAY) AS is_consecutive
		 FROM login_rewards WHERE user_id = ?${connection ? " FOR UPDATE" : ""}`,
		[userId],
	);
	return rows[0];
};

const nextStreakDay = (row: LoginRewardRow): number => (row.is_consecutive ? row.streak_day + 1 : 1);

const getStatus = async (userId: number): Promise<{ claimed_today: boolean; streak_day: number }> => {
	await ensureRow(userId);
	const row = await fetchRow(userId);
	return row.claimed_today
		? { claimed_today: true, streak_day: row.streak_day }
		: { claimed_today: false, streak_day: nextStreakDay(row) };
};

const claim = async (
	userId: number,
): Promise<{ streak_day: number; reward_currency: number; balance: number }> => {
	await ensureRow(userId);
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		const row = await fetchRow(userId, connection);
		if (row.claimed_today) throw new AlreadyClaimedTodayError();

		const streakDay = nextStreakDay(row);
		const reward = rewardForDay(streakDay);

		await connection.query(
			"UPDATE login_rewards SET streak_day = ?, last_claimed_date = CURDATE() WHERE user_id = ?",
			[streakDay, userId],
		);
		await credit(userId, reward, "daily_login_reward", undefined, connection);

		await connection.commit();
		return { streak_day: streakDay, reward_currency: reward, balance: await getBalance(userId) };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export { AlreadyClaimedTodayError, REWARD_BY_DAY, rewardForDay, getStatus, claim };
