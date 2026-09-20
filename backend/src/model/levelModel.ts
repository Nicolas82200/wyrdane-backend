import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import db from "./db";
import { credit, creditFreePacks } from "./currencyModel";
import { grantCard, getOwnedQuantity, MAX_COPIES_PER_CARD, DUST_VALUE_BY_RARITY } from "./collectionModel";

import type { Cards } from "../types";

// Remplace l'ancien barème d'or par match classé (voir devlog, WIN_STREAK_REWARD_TIERS
// retiré de rankedModel) : un match classé/partie rapide rapporte désormais de
// l'XP de compte plutôt que de l'or directement. Le solo n'en rapporte pas,
// comme il ne rapportait déjà plus d'or depuis 2026-08-26.
const XP_WIN_NETWORK = 50;
const XP_LOSS_NETWORK = 15;

// XP requise pour passer du niveau `level` à `level + 1` : croissance
// linéaire, +5 XP de palier par niveau (105 au niveau 1, 110 au niveau 2,
// 115 au niveau 3...). Contrairement à l'ancienne courbe géométrique, ne
// dépend pas du seuil précédent — calcul direct, pas de dérive d'arrondi.
const XP_CURVE_BASE = 100;
const XP_CURVE_STEP = 5;

const xpToReachNextLevel = (level: number): number => XP_CURVE_BASE + XP_CURVE_STEP * level;

// Multiplicateur appliqué à XP_WIN_NETWORK selon la série de victoires en
// cours (ranked_stats.win_streak, incrémentée AVANT cet appel côté
// rankedModel.confirmMatch) : palier atteint à 3/5/7 victoires d'affilée,
// jamais appliqué à une défaite (streak retombe à 0). Remplace l'ancien
// barème d'or par palier (WIN_STREAK_REWARD_TIERS) sur le même principe,
// mais agit sur l'XP plutôt que sur l'or directement.
const WIN_STREAK_XP_MULTIPLIER_TIERS: { minStreak: number; multiplier: number }[] = [
	{ minStreak: 7, multiplier: 1.75 },
	{ minStreak: 5, multiplier: 1.5 },
	{ minStreak: 3, multiplier: 1.25 },
	{ minStreak: 0, multiplier: 1 },
];

const winXpForStreak = (streak: number): number => {
	const tier = WIN_STREAK_XP_MULTIPLIER_TIERS.find((t) => streak >= t.minStreak);
	return Math.round(XP_WIN_NETWORK * (tier?.multiplier ?? 1));
};

// Rareté de la carte offerte tous les 5 niveaux, cyclique sur 20 niveaux
// (5 → Commune, 10 → Rare, 15 → Épique, 20/40/60... → Légendaire). Un niveau
// multiple de 25 est intercepté avant cette table (voir rewardKindForLevel) :
// il offre un pack plutôt qu'une carte, même s'il est aussi multiple de 5.
const CARD_RARITY_BY_LEVEL_MOD_20: Record<number, string> = {
	5: "Commune",
	10: "Rare",
	15: "Épique",
	0: "Légendaire",
};

// Or accordé aux niveaux qui n'offrent ni carte ni pack : monte à chaque
// niveau au sein d'une série de 4 (25/50/75/100), puis retombe à 25 dès
// qu'un niveau a offert autre chose que de l'or (carte ou pack, toujours
// multiple de 5) — level % 5 vaut 1/2/3/4 sur ces niveaux-là, jamais 0,
// donc la position dans la série se lit directement dessus.
const GOLD_TIER_BY_LEVEL_MOD_5: Record<number, number> = {
	1: 25,
	2: 50,
	3: 75,
	4: 100,
};
const goldRewardForLevel = (level: number): number => GOLD_TIER_BY_LEVEL_MOD_5[level % 5] ?? 100;

// Or accordé EN PLUS de la carte/du pack aux paliers multiples de 5/25.
const GOLD_BONUS_PER_CARD_LEVEL = 100;
const GOLD_BONUS_PER_PACK_LEVEL = 200;

type LevelRewardKind = "card" | "pack" | "gold";

interface LevelReward {
	level: number;
	type: LevelRewardKind;
	card?: Cards;
	dusted?: boolean;
	gold?: number;
}

interface LevelRow extends RowDataPacket {
	level: number;
	xp: number;
}

// Plafond du catalogue de récompenses parcourable dans la popup client (voir
// getRewardCatalog) : au moins ce niveau, étendu dynamiquement pour toujours
// couvrir un peu au-delà du niveau réel du joueur (CATALOG_LOOKAHEAD).
const CATALOG_MIN_LEVEL = 60;
const CATALOG_LOOKAHEAD = 10;

const rewardKindForLevel = (level: number): { kind: LevelRewardKind; rarity?: string } => {
	if (level % 25 === 0) return { kind: "pack" };
	if (level % 5 === 0) return { kind: "card", rarity: CARD_RARITY_BY_LEVEL_MOD_20[level % 20] ?? "Commune" };
	return { kind: "gold" };
};

const fetchRandomCardByRarity = async (
	rarity: string,
	connection: PoolConnection,
): Promise<(Cards & RowDataPacket) | null> => {
	const [rows] = await connection.query<(Cards & RowDataPacket)[]>(
		"SELECT * FROM cards WHERE rarity = ? AND card_type != 'Ressource'",
		[rarity],
	);
	if (rows.length === 0) return null;
	return rows[Math.floor(Math.random() * rows.length)];
};

// Octroie la récompense d'un niveau franchi. Une carte déjà possédée au
// plafond (MAX_COPIES_PER_CARD) est convertie en or (même logique de dust que
// packModel.drawAndGrantCards) plutôt que perdue silencieusement. Les paliers
// carte/pack créditent en plus un bonus d'or fixe (GOLD_BONUS_PER_*_LEVEL),
// cumulé avec un éventuel dust — `gold` sur le reward reflète toujours le
// montant total réellement crédité, pas seulement le bonus.
// Journalise dans level_rewards la récompense déjà octroyée (aucun nouveau
// crédit ici) — permet à la popup client de retrouver plus tard ce qui a été
// obtenu à ce niveau et si le joueur l'a "vu" (claimed_at, voir claimRewards).
const logLevelReward = async (
	userId: number,
	reward: LevelReward,
	connection: PoolConnection,
): Promise<void> => {
	await connection.query("INSERT INTO level_rewards (user_id, level, type, gold) VALUES (?, ?, ?, ?)", [
		userId,
		reward.level,
		reward.type,
		reward.gold ?? 0,
	]);
};

const grantLevelReward = async (
	userId: number,
	level: number,
	connection: PoolConnection,
): Promise<LevelReward> => {
	const { kind, rarity } = rewardKindForLevel(level);
	let reward: LevelReward;

	if (kind === "pack") {
		await creditFreePacks(userId, 1, connection);
		await credit(userId, GOLD_BONUS_PER_PACK_LEVEL, "level_reward_gold", `level_${level}`, connection);
		reward = { level, type: "pack", gold: GOLD_BONUS_PER_PACK_LEVEL };
	} else if (kind === "card") {
		const card = await fetchRandomCardByRarity(rarity!, connection);
		if (!card) {
			// Repli défensif : aucune carte de cette rareté en base — le bonus
			// du palier remplace alors entièrement la récompense.
			await credit(userId, GOLD_BONUS_PER_CARD_LEVEL, "level_reward_gold", `level_${level}`, connection);
			reward = { level, type: "gold", gold: GOLD_BONUS_PER_CARD_LEVEL };
		} else {
			const alreadyOwned = await getOwnedQuantity(userId, card.id, connection);
			if (alreadyOwned >= MAX_COPIES_PER_CARD) {
				const gold = (DUST_VALUE_BY_RARITY[card.rarity] ?? 0) + GOLD_BONUS_PER_CARD_LEVEL;
				await credit(userId, gold, "level_reward_dust", `level_${level}`, connection);
				reward = { level, type: "card", card, dusted: true, gold };
			} else {
				await grantCard(userId, card.id, 1, connection);
				await credit(userId, GOLD_BONUS_PER_CARD_LEVEL, "level_reward_gold", `level_${level}`, connection);
				reward = { level, type: "card", card, dusted: false, gold: GOLD_BONUS_PER_CARD_LEVEL };
			}
		}
	} else {
		const gold = goldRewardForLevel(level);
		await credit(userId, gold, "level_reward_gold", `level_${level}`, connection);
		reward = { level, type: "gold", gold };
	}

	await logLevelReward(userId, reward, connection);
	return reward;
};

const getLevel = async (userId: number): Promise<{ level: number; xp: number; xpToNext: number }> => {
	const [rows] = await db.query<LevelRow[]>("SELECT level, xp FROM users WHERE id = ?", [userId]);
	const level = rows[0]?.level ?? 1;
	const xp = rows[0]?.xp ?? 0;
	return { level, xp, xpToNext: xpToReachNextLevel(level) };
};

interface XpResult {
	level: number;
	xp: number;
	xpToNext: number;
	rewards: LevelReward[];
}

// Coeur de l'octroi d'XP, à l'intérieur d'une transaction déjà ouverte par
// l'appelant (verrou FOR UPDATE posé ici sur `users`) : utilisé par
// rankedModel.confirmMatch pour que mise à jour du MMR, crédit d'XP et
// récompenses de niveau restent atomiques avec le reste du match.
const applyXp = async (userId: number, amount: number, connection: PoolConnection): Promise<XpResult> => {
	const [rows] = await connection.query<LevelRow[]>(
		"SELECT level, xp FROM users WHERE id = ? FOR UPDATE",
		[userId],
	);
	let level = rows[0]?.level ?? 1;
	let xp = (rows[0]?.xp ?? 0) + amount;
	const rewards: LevelReward[] = [];

	let threshold = xpToReachNextLevel(level);
	while (xp >= threshold) {
		xp -= threshold;
		level += 1;
		rewards.push(await grantLevelReward(userId, level, connection));
		threshold = xpToReachNextLevel(level);
	}

	await connection.query("UPDATE users SET level = ?, xp = ? WHERE id = ?", [level, xp, userId]);
	return { level, xp, xpToNext: threshold, rewards };
};

// Variante autonome (sa propre transaction) pour les appelants qui n'ont pas
// déjà de connexion en cours (tests, futurs points d'entrée hors match).
const addXp = async (userId: number, amount: number): Promise<XpResult> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		const result = await applyXp(userId, amount, connection);
		await connection.commit();
		return result;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

interface LevelRewardCatalogEntry {
	level: number;
	kind: LevelRewardKind;
	rarity?: string;
	gold?: number;
}

// Catalogue déterministe (aucune requête DB) des récompenses par niveau,
// consommé par la popup client pour afficher aussi les niveaux pas encore
// atteints. Couvre toujours au moins CATALOG_MIN_LEVEL, étendu pour dépasser
// un peu le niveau réel du joueur (CATALOG_LOOKAHEAD) plutôt que de s'arrêter
// pile dessus.
const getRewardCatalog = (currentLevel: number): LevelRewardCatalogEntry[] => {
	const maxLevel = Math.max(CATALOG_MIN_LEVEL, currentLevel + CATALOG_LOOKAHEAD);
	const entries: LevelRewardCatalogEntry[] = [];
	for (let level = 2; level <= maxLevel; level++) {
		const { kind, rarity } = rewardKindForLevel(level);
		entries.push(kind === "gold" ? { level, kind, gold: goldRewardForLevel(level) } : { level, kind, rarity });
	}
	return entries;
};

interface UserLevelRewardRow extends RowDataPacket {
	level: number;
	type: LevelRewardKind;
	gold: number;
	claimed_at: string | null;
}

interface UserLevelReward {
	level: number;
	type: LevelRewardKind;
	gold: number;
	claimed: boolean;
}

// Récompenses réellement journalisées pour ce joueur (voir logLevelReward) —
// un niveau atteint avant l'introduction de cette table (2026-09) n'y
// apparaît simplement pas ; le contrôleur le traite alors comme acquis sans
// rien à réclamer (voir levelController.getMyLevelRewards).
const getUserRewards = async (userId: number): Promise<UserLevelReward[]> => {
	const [rows] = await db.query<UserLevelRewardRow[]>(
		"SELECT level, type, gold, claimed_at FROM level_rewards WHERE user_id = ? ORDER BY level ASC",
		[userId],
	);
	return rows.map((row) => ({
		level: row.level,
		type: row.type,
		gold: row.gold,
		claimed: row.claimed_at !== null,
	}));
};

// Marque comme "vues" les récompenses des niveaux demandés (bouton
// "récupérer" ou "tout récupérer" côté client) — accusé de réception
// seulement, l'octroi réel a déjà eu lieu dans grantLevelReward. Ignore
// silencieusement les niveaux invalides/déjà réclamés/pas encore atteints.
const claimRewards = async (userId: number, levels: number[]): Promise<number[]> => {
	const validLevels = levels.filter((level) => Number.isInteger(level) && level > 1);
	if (validLevels.length === 0) return [];

	const [result] = await db.query<ResultSetHeader>(
		`UPDATE level_rewards SET claimed_at = NOW()
		 WHERE user_id = ? AND claimed_at IS NULL AND level IN (${validLevels.map(() => "?").join(",")})`,
		[userId, ...validLevels],
	);
	if (result.affectedRows === 0) return [];

	const [rows] = await db.query<RowDataPacket[]>(
		`SELECT level FROM level_rewards WHERE user_id = ? AND claimed_at IS NOT NULL AND level IN (${validLevels
			.map(() => "?")
			.join(",")})`,
		[userId, ...validLevels],
	);
	return rows.map((row) => row.level as number);
};

export type { LevelReward, LevelRewardCatalogEntry, UserLevelReward };
export {
	XP_WIN_NETWORK,
	XP_LOSS_NETWORK,
	xpToReachNextLevel,
	winXpForStreak,
	getLevel,
	applyXp,
	addXp,
	getRewardCatalog,
	getUserRewards,
	claimRewards,
};
