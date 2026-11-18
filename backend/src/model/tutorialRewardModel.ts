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
//
// Composition FIXE depuis le 2026-11-18 (demande utilisateur) : plus aucun
// tirage de rareté, le lot contient toujours exactement 10 communes, 6 rares,
// 3 épiques et 1 légendaire. Le client en fait quatre "ouvertures de pack"
// successives, une par rareté (voir PackShop.REWARD_RARITY_COLUMNS côté jeu) :
// un lot de taille variable y casserait les grilles annoncées (2x5, 2x3, 1x3,
// 1 seule carte). Avant, les raretés étaient tirées au sort en 40/30/20/10.
const TUTORIAL_REWARD_RARITY_COUNTS: Record<string, number> = {
	Commune: 10,
	Rare: 6,
	Épique: 3,
	Légendaire: 1,
};

const TUTORIAL_REWARD_CARDS = Object.values(TUTORIAL_REWARD_RARITY_COUNTS).reduce((a, b) => a + b, 0);

// La liste des raretés à tirer, dans l'ordre d'annonce côté client (communes
// d'abord, légendaire en dernier) : un élément par carte du lot.
const rewardRaritySequence = (): string[] =>
	Object.entries(TUTORIAL_REWARD_RARITY_COUNTS).flatMap(([rarity, count]) => Array<string>(count).fill(rarity));

interface DrawableCardRow extends Cards, RowDataPacket {}

interface TutorialRewardCard extends DrawableCardRow {
	dusted: boolean;
	goldEarned: number;
}

// Tire uniformément une carte de la rareté demandée. Repli sur n'importe
// quelle autre rareté non vide si le catalogue n'en contient aucune de celle-là
// (catalogue incomplet en développement) : mieux vaut un lot complet d'une
// rareté approchante qu'une récompense tronquée.
const pickOfRarity = (poolByRarity: Map<string, DrawableCardRow[]>, rarity: string): DrawableCardRow => {
	const cards = poolByRarity.get(rarity) ?? [];
	if (cards.length > 0) return cards[Math.floor(Math.random() * cards.length)];
	const fallback = [...poolByRarity.values()].filter((group) => group.length > 0);
	const group = fallback[Math.floor(Math.random() * fallback.length)];
	return group[Math.floor(Math.random() * group.length)];
};

const fetchPoolByRarity = async (): Promise<Map<string, DrawableCardRow[]>> => {
	const [rows] = await db.query<DrawableCardRow[]>(
		"SELECT * FROM cards WHERE card_type != 'Ressource' AND rarity IN (?)",
		[Object.keys(TUTORIAL_REWARD_RARITY_COUNTS)],
	);
	const byRarity = new Map<string, DrawableCardRow[]>();
	for (const rarity of Object.keys(TUTORIAL_REWARD_RARITY_COUNTS)) byRarity.set(rarity, []);
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
		for (const rarity of rewardRaritySequence()) {
			const card = pickOfRarity(poolByRarity, rarity);
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
	TUTORIAL_REWARD_RARITY_COUNTS,
	rewardRaritySequence,
	pickOfRarity,
	hasClaimed,
	claimTutorialReward,
};
