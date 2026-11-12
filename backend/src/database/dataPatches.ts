// Patchs de données idempotents appliqués à chaque démarrage du serveur.
// L'hébergement (Render free) n'offre pas de shell pour jouer à la main les
// patchs SQL de src/database/patches/ contre la base de production : le
// serveur les applique donc lui-même au boot. Chaque patch doit pouvoir être
// rejoué indéfiniment sans effet au-delà de la première application (clause
// WHERE qui ne matche plus rien une fois le patch passé).
import type { ResultSetHeader } from "mysql2/promise";
import pool from "../model/db";

// Pendant SQL de patches/2026-07-rename-resource-cards.sql : aligne les noms
// des cartes-ressource Mort-Vivant et Démon sur le client Godot (le lien
// catalogue ↔ carte se fait par le nom exact, un nom divergent rend la carte
// invisible dans la collection).
const RESOURCE_CARD_RENAMES: { from: string; to: string; effect: string }[] = [
	{
		from: "Éclat d'Âme",
		to: "Chair",
		effect: "Ajoute 1 Chair à votre réserve. Vous ne pouvez jouer qu'une ressource par tour.",
	},
	{
		from: "Fragment de Pacte",
		to: "Âme",
		effect: "Ajoute 1 Âme à votre réserve. Vous ne pouvez jouer qu'une ressource par tour.",
	},
	// Ajoutés le 2026-11-12 : ces deux-là avaient été oubliés lors du patch
	// d'origine, qui n'avait traité que Mort-Vivant et Démon. Conséquence
	// vécue en prod : les 15 cartes-ressource des decks de départ Humain et
	// Abomination étaient écartées en silence du payload envoyé au client
	// (CardLibrary.sync_backend_catalog ignore un nom inconnu, DeckManager
	// exclut toute carte sans backend_id), donc ces deux decks arrivaient à
	// 25 cartes sans aucune source de mana.
	{
		from: "Sceau du Royaume",
		to: "Sceau",
		effect: "Ajoute 1 Sceau à votre réserve, ressource pour jouer les cartes Humain.",
	},
	{
		from: "Éclat d'Anomalie",
		to: "Anomalie",
		effect: "Ajoute 1 Anomalie à votre réserve, ressource pour jouer les cartes Abomination.",
	},
];

// cards_data.sql n'est joué qu'au seed initial : ses corrections n'atteignent
// jamais une base déjà peuplée. La dérive de texte (effect/flavor) est inerte
// — le client affiche ses propres .tres et ses traductions, il ne lit du
// catalogue que l'id et le nom — mais la RARETÉ, elle, est lue côté serveur :
// collectionModel.buyCard en tire le prix d'achat à l'unité, packModel et
// levelModel en tirent les poids de tirage. Une rareté périmée en prod fait
// donc facturer une carte au mauvais prix et la fait sortir des packs à la
// mauvaise fréquence. Le coût est corrigé dans le même passage par cohérence
// (il n'est pas lu par le jeu, qui prend celui du .tres, mais il est servi
// par /api/cards).
const CARD_STAT_FIXES: { name: string; rarity: string; cost: number }[] = [
	{ name: "Brouillard Pestilentiel", rarity: "Épique", cost: 4 },
	{ name: "Le Patient Zéro", rarity: "Épique", cost: 5 },
	{ name: "Chuchotement Qui Change la Forme", rarity: "Rare", cost: 2 },
];

export const runDataPatches = async (): Promise<void> => {
	for (const rename of RESOURCE_CARD_RENAMES) {
		const [result] = await pool.query<ResultSetHeader>(
			"UPDATE cards SET name = ?, effect = ? WHERE name = ? AND card_type = 'Ressource'",
			[rename.to, rename.effect, rename.from],
		);
		if (result.affectedRows > 0) {
			console.log(`→ Patch données : carte-ressource « ${rename.from} » renommée « ${rename.to} »`);
		}
	}

	for (const fix of CARD_STAT_FIXES) {
		const [result] = await pool.query<ResultSetHeader>(
			"UPDATE cards SET rarity = ?, cost = ? WHERE name = ? AND (rarity <> ? OR cost <> ?)",
			[fix.rarity, fix.cost, fix.name, fix.rarity, fix.cost],
		);
		if (result.affectedRows > 0) {
			console.log(`→ Patch données : « ${fix.name} » passe en ${fix.rarity}, coût ${fix.cost}`);
		}
	}
};
