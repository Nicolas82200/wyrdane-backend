import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import db from "./db";
import { grantCard, getOwnedQuantity, MAX_COPIES_PER_CARD, DUST_VALUE_BY_RARITY } from "./collectionModel";
import { credit, getBalance } from "./currencyModel";

import type { Cards } from "../types";

// Récompense de fin de tutoriel : les 4 decks de départ (voir
// data/starterDecks.ts) ne contiennent que des serviteurs et quelques
// éphémères — un nouveau joueur n'avait donc jamais vu un Rituel ni un
// Enchantement avant d'en ouvrir des packs. Ce lot de 20 cartes tirées dans
// TOUT le catalogue (hors ressources) comble ce trou dès la sortie du
// tutoriel.
const TUTORIAL_REWARD_CARDS = 20;

// Pondération volontairement bien plus généreuse que celle des packs
// (packModel.RARITY_WEIGHTS, 58/25/12/5) : c'est une récompense unique, pas
// une source récurrente — elle sert à faire découvrir les raretés hautes.
const TUTORIAL_RARITY_WEIGHTS: Record<string, number> = {
	Commune: 40,
	Rare: 30,
	Épique: 20,
	Légendaire: 10,
};

interface DrawableCardRow extends Cards, RowDataPacket {}

interface TutorialRewardCard extends DrawableCardRow {
	dusted: boolean;
	goldEarned: number;
}

// Tire une carte par rareté d'abord, puis uniformément parmi les cartes de
// cette rareté — contrairement à packModel.pickWeighted, qui pondère chaque
// CARTE par le poids de sa rareté et fait donc dépendre les probabilités
// réelles du nombre de cartes existantes par rareté. Ici les 40/30/20/10
// demandés doivent être exactement respectés.
const pickByRarity = (poolByRarity: Map<string, DrawableCardRow[]>): DrawableCardRow => {
	const available = [...poolByRarity.entries()].filter(([, cards]) => cards.length > 0);
	const total = available.reduce((sum, [rarity]) => sum + (TUTORIAL_RARITY_WEIGHTS[rarity] ?? 0), 0);
	let roll = Math.random() * total;
	for (const [rarity, cards] of available) {
		roll -= TUTORIAL_RARITY_WEIGHTS[rarity] ?? 0;
		if (roll <= 0) return cards[Math.floor(Math.random() * cards.length)];
	}
	const [, fallback] = available[available.length - 1];
	return fallback[Math.floor(Math.random() * fallback.length)];
};

const fetchPoolByRarity = async (): Promise<Map<string, DrawableCardRow[]>> => {
	const [rows] = await db.query<DrawableCardRow[]>(
		"SELECT * FROM cards WHERE card_type != 'Ressource' AND rarity IN (?)",
		[Object.keys(TUTORIAL_RARITY_WEIGHTS)],
	);
	const byRarity = new Map<string, DrawableCardRow[]>();
	for (const rarity of Object.keys(TUTORIAL_RARITY_WEIGHTS)) byRarity.set(rarity, []);
	for (const row of rows) byRarity.get(row.rarity)?.push(row);
	return byRarity;
};

const hasClaimed = async (userId: number, connection?: PoolConnection): Promise<boolean> => {
	const runner = connection ?? db;
	const [rows] = await runner.query<(RowDataPacket & { tutorial_reward_claimed_at: string | null })[]>(
		`SELECT tutorial_reward_claimed_at FROM \`users\` WHERE id = ?${connection ? " FOR UPDATE" : ""}`,
		[userId],
	);
	return rows.length > 0 && rows[0].tutorial_reward_claimed_at !== null;
};

// Idempotent, même garde FOR UPDATE que collectionController.claimStarter :
// deux appels concurrents (retry réseau en sortie de tutoriel) sérialisent sur
// le verrou de la ligne users au lieu de granter deux fois. Un exemplaire
// au-delà de MAX_COPIES_PER_CARD est converti en or, comme dans un pack.
const claimTutorialReward = async (
	userId: number,
): Promise<{ claimed: boolean; cards: TutorialRewardCard[]; balance: number }> => {
	if (await hasClaimed(userId)) return { claimed: false, cards: [], balance: await getBalance(userId) };

	const poolByRarity = await fetchPoolByRarity();
	if ([...poolByRarity.values()].every((cards) => cards.length === 0)) {
		throw new Error("Aucune carte disponible pour la récompense de tutoriel");
	}

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		if (await hasClaimed(userId, connection)) {
			await connection.commit();
			return { claimed: false, cards: [], balance: await getBalance(userId) };
		}

		const pendingQuantities = new Map<number, number>();
		const cards: TutorialRewardCard[] = [];
		for (let i = 0; i < TUTORIAL_REWARD_CARDS; i++) {
			const card = pickByRarity(poolByRarity);
			const projected = (await getOwnedQuantity(userId, card.id, connection)) + (pendingQuantities.get(card.id) ?? 0);
			if (projected >= MAX_COPIES_PER_CARD) {
				const goldEarned = DUST_VALUE_BY_RARITY[card.rarity] ?? 0;
				await credit(userId, goldEarned, "tutorial_reward_dust", String(card.id), connection);
				cards.push({ ...card, dusted: true, goldEarned });
			} else {
				await grantCard(userId, card.id, 1, connection);
				pendingQuantities.set(card.id, (pendingQuantities.get(card.id) ?? 0) + 1);
				cards.push({ ...card, dusted: false, goldEarned: 0 });
			}
		}

		await connection.query("UPDATE `users` SET tutorial_reward_claimed_at = NOW() WHERE id = ?", [userId]);
		await connection.commit();
		return { claimed: true, cards, balance: await getBalance(userId) };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export type { TutorialRewardCard };
export {
	TUTORIAL_REWARD_CARDS,
	TUTORIAL_RARITY_WEIGHTS,
	pickByRarity,
	hasClaimed,
	claimTutorialReward,
};
