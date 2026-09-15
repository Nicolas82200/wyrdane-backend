import type { RowDataPacket } from "mysql2";
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

// XP requise pour passer du niveau `level` à `level + 1`. Courbe légèrement
// croissante : chaque niveau demande 10 XP de plus que le précédent.
const xpToReachNextLevel = (level: number): number => 100 + 10 * (level - 1);

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

// Or accordé aux niveaux qui n'offrent ni carte ni pack.
const GOLD_REWARD_PER_LEVEL = 20;

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
// packModel.drawAndGrantCards) plutôt que perdue silencieusement.
const grantLevelReward = async (
	userId: number,
	level: number,
	connection: PoolConnection,
): Promise<LevelReward> => {
	const { kind, rarity } = rewardKindForLevel(level);

	if (kind === "pack") {
		await creditFreePacks(userId, 1, connection);
		return { level, type: "pack" };
	}

	if (kind === "card") {
		const card = await fetchRandomCardByRarity(rarity!, connection);
		if (!card) {
			// Repli défensif : aucune carte de cette rareté en base.
			await credit(userId, GOLD_REWARD_PER_LEVEL, "level_reward_gold", `level_${level}`, connection);
			return { level, type: "gold", gold: GOLD_REWARD_PER_LEVEL };
		}
		const alreadyOwned = await getOwnedQuantity(userId, card.id, connection);
		if (alreadyOwned >= MAX_COPIES_PER_CARD) {
			const gold = DUST_VALUE_BY_RARITY[card.rarity] ?? 0;
			await credit(userId, gold, "level_reward_dust", `level_${level}`, connection);
			return { level, type: "card", card, dusted: true, gold };
		}
		await grantCard(userId, card.id, 1, connection);
		return { level, type: "card", card, dusted: false };
	}

	await credit(userId, GOLD_REWARD_PER_LEVEL, "level_reward_gold", `level_${level}`, connection);
	return { level, type: "gold", gold: GOLD_REWARD_PER_LEVEL };
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

export type { LevelReward };
export {
	XP_WIN_NETWORK,
	XP_LOSS_NETWORK,
	xpToReachNextLevel,
	getLevel,
	applyXp,
	addXp,
};
