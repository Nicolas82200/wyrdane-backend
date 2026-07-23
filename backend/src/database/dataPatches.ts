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
};
