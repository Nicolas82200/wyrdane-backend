import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import db from "./db";
import { grantCard, getOwnedQuantity, findOwnedCardIds, MAX_COPIES_PER_CARD, DUST_VALUE_BY_RARITY } from "./collectionModel";
import { credit, debit, debitFreePack, creditFreePacks, getBalance, getFreePacks } from "./currencyModel";
import { progressForPackOpen } from "./uniqueQuestModel";
import { progressForPackPurchase } from "./onboardingQuestModel";
import { getLevel } from "./levelModel";

import type { Cards } from "../types";

const PACK_COST = 500;
const CARDS_PER_PACK = 5;
// Achat en une seule requête (voir buyPacks) : plafond raisonnable, aligné sur
// le rate-limit de la route /buy plutôt que sur une vraie limite métier.
const MAX_BUY_QUANTITY = 50;

// Pondération de tirage par rareté (somme non contrainte à 100, seul le
// ratio compte). Ajuster ici seul suffit à retoucher l'économie des packs.
const RARITY_WEIGHTS: Record<string, number> = {
	Commune: 58,
	Rare: 25,
	Épique: 12,
	Légendaire: 5,
};

// Protection anti-doublon (2026-09-28). Le poids d'une carte dont le joueur
// possède déjà au moins un exemplaire est multiplié par
// duplicateWeightFactor(completion) : le tirage penche donc vers ce qui manque
// réellement, d'autant plus que la collection est avancée.
//
// Pourquoi lier la force au taux de complétion plutôt que de l'appliquer à
// plat : un joueur qui débute A BESOIN de doublons (4 exemplaires sont
// nécessaires pour construire un deck), alors qu'un joueur à 95 % n'attend plus
// que 15 cartes et tirait avant ~0,8 % de chance par carte manquante. La force
// suit donc la frustration réelle.
//
// Propriété qui rend le mécanisme sûr : à collection complète, TOUTES les
// cartes subissent la même réduction, donc les poids RELATIFS redeviennent
// exactement ceux de RARITY_WEIGHTS — la protection s'efface d'elle-même au
// lieu de dégénérer, et le remplissage des exemplaires 2/3/4 se fait ensuite
// aux probabilités d'origine. Mesuré en simulation (5 parties/jour) : posséder
// un exemplaire des 300 cartes en packs seuls passe de ~24 mois à ~5 mois,
// sans ralentir la collection complète à 4 exemplaires.
const MAX_DUPLICATE_WEIGHT_REDUCTION = 0.9;

export const duplicateWeightFactor = (completion: number): number =>
	1 - MAX_DUPLICATE_WEIGHT_REDUCTION * Math.min(Math.max(completion, 0), 1);

interface DrawableCardRow extends Cards, RowDataPacket {}

// Carte tirée telle que renvoyée au client : dusted/goldEarned informent
// l'écran d'ouverture de packs qu'un exemplaire au-delà de
// MAX_COPIES_PER_CARD a été converti en or plutôt qu'ajouté à la collection.
interface DrawResult extends DrawableCardRow {
	dusted: boolean;
	goldEarned: number;
}

// Les cartes-ressource ne sont pas de vraies récompenses de collection (une
// poignée par race, déjà données par claim-starter) : exclues du pool.
const fetchDrawablePool = async (): Promise<DrawableCardRow[]> => {
	const [rows] = await db.query<DrawableCardRow[]>(
		"SELECT * FROM cards WHERE card_type != 'Ressource'",
	);
	return rows;
};

// `ownedIds`/`completion` omis (ou ensemble vide) : tirage brut par rareté,
// comportement d'avant la protection anti-doublon — c'est ce que font les tests
// de distribution, et le repli si la collection n'a pas pu être lue.
export const pickWeighted = (
	pool: DrawableCardRow[],
	ownedIds: Set<number> = new Set(),
	completion = 0,
): DrawableCardRow => {
	const factor = duplicateWeightFactor(completion);
	const weightOf = (card: DrawableCardRow): number =>
		(RARITY_WEIGHTS[card.rarity] ?? 0) * (ownedIds.has(card.id) ? factor : 1);

	const total = pool.reduce((sum, card) => sum + weightOf(card), 0);
	let roll = Math.random() * total;
	for (const card of pool) {
		roll -= weightOf(card);
		if (roll <= 0) return card;
	}
	return pool[pool.length - 1];
};

// Les cartes tirées plus tôt dans le MÊME pack rejoignent `ownedIds` au fur et
// à mesure : sans ça, un pack pourrait offrir deux fois la même carte neuve
// alors qu'il en reste d'autres à découvrir.
const drawWeightedCards = (
	pool: DrawableCardRow[],
	count: number,
	ownedIds: Set<number>,
	completion: number,
): DrawableCardRow[] => {
	const seen = new Set(ownedIds);
	const draws: DrawableCardRow[] = [];
	for (let i = 0; i < count; i++) {
		const card = pickWeighted(pool, seen, completion);
		draws.push(card);
		seen.add(card.id);
	}
	return draws;
};

// Tire CARDS_PER_PACK cartes pondérées par rareté et les octroie au joueur
// (partagé par openPack/openOwnedPack, appelé après que l'appelant a débité
// le coût dans la même transaction — un exemplaire qui porterait la quantité
// possédée au-delà de MAX_COPIES_PER_CARD, déjà possédé ou doublon au sein du
// même pack, n'est pas octroyé : il est converti en or).
const drawAndGrantCards = async (
	userId: number,
	pool: DrawableCardRow[],
	connection: PoolConnection,
): Promise<DrawResult[]> => {
	const ownedIds = await findOwnedCardIds(userId, connection);
	// Complétion mesurée sur le pool réellement tirable (cartes-ressource
	// exclues des deux côtés), jamais sur la table cards entière.
	const completion = pool.length > 0 ? ownedIds.size / pool.length : 0;
	const drawn = drawWeightedCards(pool, CARDS_PER_PACK, ownedIds, completion);
	const pendingQuantities = new Map<number, number>();
	const results: DrawResult[] = [];
	for (const card of drawn) {
		const alreadyOwned = await getOwnedQuantity(userId, card.id, connection);
		const pending = pendingQuantities.get(card.id) ?? 0;
		const projectedQuantity = alreadyOwned + pending;

		if (projectedQuantity >= MAX_COPIES_PER_CARD) {
			const goldEarned = DUST_VALUE_BY_RARITY[card.rarity] ?? 0;
			await credit(userId, goldEarned, "pack_duplicate_dust", String(card.id), connection);
			results.push({ ...card, dusted: true, goldEarned });
		} else {
			await grantCard(userId, card.id, 1, connection);
			pendingQuantities.set(card.id, pending + 1);
			results.push({ ...card, dusted: false, goldEarned: 0 });
		}
	}
	return results;
};

// Débite le coût, tire et octroie les cartes, le tout en transaction (même
// pattern que rankedModel.confirmMatch : débit/octroi ne doivent jamais être
// partiels). `free` saute le débit (route dev /open-free, gardée par
// DEV_FREE_PACKS).
const openPack = async (userId: number, free = false): Promise<{ cards: DrawResult[]; balance: number }> => {
	const pool = await fetchDrawablePool();
	if (pool.length === 0) throw new Error("Aucune carte disponible pour un pack");

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		if (!free) {
			await debit(userId, PACK_COST, "pack_open", undefined, connection);
		}

		const results = await drawAndGrantCards(userId, pool, connection);

		await connection.commit();
		const balance = await getBalance(userId);
		// Volontairement HORS du try/catch transactionnel : la transaction est déjà
		// commitée (l'or a déjà été débité, les cartes déjà octroyées) — une erreur
		// ici ne doit ni déclencher un rollback (no-op sur une transaction commitée)
		// ni faire échouer la réponse au client, qui a bien reçu son pack.
		try {
			await progressForPackOpen(userId);
			if (!free) {
				const { level } = await getLevel(userId);
				await progressForPackPurchase(userId, level);
			}
		} catch (error) {
			console.error("openPack: échec de la progression de quête après commit", error);
		}
		return { cards: results, balance };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Ouvre un pack en consommant le solde de packs gratuits (quêtes hebdo,
// parrainage — voir weeklyQuestModel/referralModel) plutôt que l'or ; mêmes
// probabilités de tirage que openPack, seule la source de débit change.
const openOwnedPack = async (userId: number): Promise<{ cards: DrawResult[]; free_packs: number }> => {
	const pool = await fetchDrawablePool();
	if (pool.length === 0) throw new Error("Aucune carte disponible pour un pack");

	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		await debitFreePack(userId, connection);
		const results = await drawAndGrantCards(userId, pool, connection);

		await connection.commit();
		// Voir openPack ci-dessus : hors du try/catch transactionnel, même raison.
		try {
			await progressForPackOpen(userId);
		} catch (error) {
			console.error("openOwnedPack: échec de la progression de quête après commit", error);
		}
		return { cards: results, free_packs: await getFreePacks(userId) };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Achète `quantity` packs SANS les ouvrir : débite le coût total d'un coup et
// crédite autant de packs au stock du joueur (même compteur que les packs
// gratuits — voir currencyModel.creditFreePacks/getFreePacks. Le stock ne
// distingue plus l'origine d'un pack une fois en stock ; seule l'ouverture,
// via openOwnedPack, les consomme ensuite, un par un côté client comme pour
// les packs gratuits). Transaction unique comme openPack : débit et crédit ne
// doivent jamais être partiels.
const buyPacks = async (userId: number, quantity: number): Promise<{ balance: number; free_packs: number }> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		await debit(userId, PACK_COST * quantity, "pack_buy", undefined, connection);
		await creditFreePacks(userId, quantity, connection);
		await connection.commit();
		return { balance: await getBalance(userId), free_packs: await getFreePacks(userId) };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export {
	PACK_COST,
	CARDS_PER_PACK,
	MAX_BUY_QUANTITY,
	RARITY_WEIGHTS,
	MAX_DUPLICATE_WEIGHT_REDUCTION,
	openPack,
	openOwnedPack,
	buyPacks,
};
