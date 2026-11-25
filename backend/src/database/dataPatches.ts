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

// Pendant SQL de patches/2026-11-rename-abomination-cards.sql : les 42 cartes
// Abomination de collection renommées côté jeu le 2026-11-25 (voir
// docs/abomination-naming.md dans card-game). Même enjeu que les
// cartes-ressource ci-dessus, le lien se faisant par le nom FR exact : tant
// que la base garde l'ancien nom, CardLibrary.sync_backend_catalog l'ignore,
// DeckManager exclut la carte faute de backend_id et PackShop.build_entries la
// retire de la révélation — un pack de 5 cartes en affichait 4, les manquantes
// étant pourtant bien octroyées côté serveur.
//
// ⚠ Doit passer AVANT toute sync de cards_data.sql (syncCardsFromFile
// correspond par nom et ne supprime jamais : sans ce renommage préalable elle
// créerait 42 lignes neuves et orphelinerait les anciennes, auxquelles les
// user_cards/deck_cards des joueurs sont rattachés). Appliqué au boot, donc
// l'ordre est garanti de lui-même.
export const ABOMINATION_CARD_RENAMES: { from: string; to: string }[] = [
	{ from: "Respir Qui Change Tout", to: "Haleine Commune" },
	{ from: "Rituel du Ventre Qui Prend Tout", to: "Rituel de la Digestion" },
	{ from: "Puits Qui Avale Tout", to: "Puits Glouton" },
	{ from: "Ce Qu'on a Laissé Pousser", to: "Jachère" },
	{ from: "Signe Qui Répond", to: "Appel Entendu" },
	{ from: "Visage-Encore-Flou", to: "Visage Encore Flou" },
	{ from: "Faim Sans Fond", to: "Gosier Béant" },
	{ from: "Masse-Qui-Ne-Cesse", to: "Masse Mouvante" },
	{ from: "Halo Qui Encourage le Changement", to: "Aura de Croissance" },
	{ from: "Vapeur Qui S'Accroche", to: "Vapeur Tenace" },
	{ from: "Main-Qui-Choisit", to: "La Main Qui Choisit" },
	{ from: "Ce-Qui-N'a-Plus-de-Bords", to: "Débordement" },
	{ from: "Ce-Qui-Ne-Finit-Jamais-de-Grandir", to: "L'Interminable" },
	{ from: "Premier Tressaut", to: "Tressaut" },
	{ from: "Ce-Qui-Se-Souvient-Par-le-Corps", to: "Mémoire de Chair" },
	{ from: "Fureur Sans Forme Fixe", to: "Fureur Informe" },
	{ from: "Étau de Chair Neuve", to: "Diminution" },
	{ from: "Peau-Trop-Grande", to: "Peau Trop Grande" },
	{ from: "Emprunt Instantané", to: "Emprunt Bref" },
	{ from: "Repaire Qui Digère la Magie", to: "Antre Affamé" },
	{ from: "Monture-et-Cavalier-Ne-Font-Qu'Un", to: "Cavalier Fondu" },
	{ from: "Pluie Qui Change", to: "Pluie Mauvaise" },
	{ from: "Doigt-Dans-les-Nerfs", to: "Doigt Dans les Nerfs" },
	{ from: "Un-Devenu-Plusieurs", to: "Dédoublement" },
	{ from: "Ce-Qui-A-Trop-Poussé", to: "Excroissance" },
	{ from: "Grand Retour Sous une Autre Forme", to: "Le Grand Retour" },
	{ from: "Rituel de la Chair Qui Recoud", to: "Rituel de la Chair Recousue" },
	{ from: "Rituel de la Forme Jamais Fixée", to: "Rituel du Remodelage" },
	{ from: "Sommeil Qui Ronge", to: "Sommeil Rongeur" },
	{ from: "Ce-Qui-Se-Partage", to: "Essaimage" },
	{ from: "Chuchotement Qui Change la Forme", to: "Murmure Précoce" },
	{ from: "Poussière Qui Change", to: "Poussière Mordante" },
	{ from: "Chant Qui Déforme", to: "Clameur de Chair" },
	{ from: "Appétit Ciblé", to: "Curée" },
	{ from: "L'Éternel Recommencement", to: "La Repousse" },
	{ from: "Rituel du Fil Sous la Peau", to: "Rituel du Fil Tendu" },
	{ from: "Locataire Sans Bail", to: "L'Occupant" },
	{ from: "Autel Qui Ne Reconnaît Rien", to: "Autel Aveugle" },
	{ from: "Ce-Qui-A-Cessé-de-S'arrêter", to: "Prolifération" },
	{ from: "Voix-Sous-la-Peau", to: "Voix Sous la Peau" },
	{ from: "Le Poids-Qui-Marche", to: "Le Fardeau" },
	{ from: "Le Reste-Qui-Veille", to: "Le Dernier Reste" },
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
	{ name: "Murmure Précoce", rarity: "Rare", cost: 2 },
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

	for (const rename of ABOMINATION_CARD_RENAMES) {
		const [result] = await pool.query<ResultSetHeader>(
			"UPDATE cards SET name = ? WHERE name = ? AND race = 'Abomination'",
			[rename.to, rename.from],
		);
		if (result.affectedRows > 0) {
			console.log(`→ Patch données : carte Abomination « ${rename.from} » renommée « ${rename.to} »`);
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
