// Decks de départ (un par race), réclamés une seule fois via
// POST /api/collection/claim-starter (voir wyrdane/scripts/tutorial/TutorialManager.gd,
// notify_victory) : chaque entrée grante la collection ET crée le deck jouable
// correspondant, pour que le nouveau joueur retrouve un deck complet et
// jouable dans "Mes Decks" dès la fin du tutoriel. Composition validée contre
// les règles du deck builder client (DeckBuilder.gd) : 40 cartes jouables
// minimum + 10 cartes-ressource minimum, 4 exemplaires max par carte non-ressource.

export interface StarterDeckEntry {
	name: string;
	quantity: number;
}

export interface StarterDeck {
	race: string;
	deckName: string;
	entries: StarterDeckEntry[];
}

export const STARTER_DECKS: StarterDeck[] = [
	{
		race: "Mort-Vivant",
		deckName: "Deck de départ — Mort-Vivant",
		entries: [
			{ name: "Goule Affamée", quantity: 4 },
			{ name: "Rampant en Décomposition", quantity: 3 },
			{ name: "Larve Cadavérique", quantity: 3 },
			{ name: "Cadavre Errant", quantity: 4 },
			{ name: "Zombie Mineur", quantity: 4 },
			{ name: "Charognard Putride", quantity: 3 },
			{ name: "Infecté Récent", quantity: 2 },
			{ name: "Souffle Nécrotique", quantity: 2 },
			{ name: "Servant Décharné", quantity: 3 },
			{ name: "Mâcheur d'Os", quantity: 3 },
			{ name: "Horde Mineure", quantity: 2 },
			{ name: "Mort-Vivant Enchaîné", quantity: 3 },
			{ name: "Vague de Putréfaction", quantity: 2 },
			{ name: "Hurleur Nécrotique", quantity: 2 },
			{ name: "Rongeur de Chair", quantity: 2 },
			{ name: "Géant Boursouflé", quantity: 2 },
			{ name: "Éclat d'Âme", quantity: 10 },
		],
	},
	{
		race: "Humain",
		deckName: "Deck de départ — Humain",
		entries: [
			{ name: "Conscrit", quantity: 3 },
			{ name: "Milicien du Bourg", quantity: 4 },
			{ name: "Éclaireur Rapide", quantity: 3 },
			{ name: "Cri de Ralliement", quantity: 2 },
			{ name: "Porteur de Bouclier", quantity: 3 },
			{ name: "Fantassin Aguerri", quantity: 4 },
			{ name: "Lancier en Ligne", quantity: 3 },
			{ name: "Archer de Guet", quantity: 2 },
			{ name: "Frappe Coordonnée", quantity: 2 },
			{ name: "Vétéran des Marches", quantity: 3 },
			{ name: "Frère d'Armes", quantity: 3 },
			{ name: "Sergent de Troupe", quantity: 3 },
			{ name: "Volée de Flèches", quantity: 2 },
			{ name: "Capitaine de Milice", quantity: 2 },
			{ name: "Champion du Peuple", quantity: 2 },
			{ name: "Chevalier du Mur", quantity: 2 },
			{ name: "Sceau du Royaume", quantity: 10 },
		],
	},
	{
		race: "Demon",
		deckName: "Deck de départ — Démon",
		entries: [
			{ name: "Suppôt des Abysses", quantity: 3 },
			{ name: "Larve Infernale", quantity: 4 },
			{ name: "Invocateur Novice", quantity: 2 },
			{ name: "Souffle Corrupteur", quantity: 2 },
			{ name: "Sangsue Infernale", quantity: 4 },
			{ name: "Croc de Braise", quantity: 3 },
			{ name: "Chuchoteur Malin", quantity: 3 },
			{ name: "Communion Écarlate", quantity: 2 },
			{ name: "Flamme Infernale", quantity: 2 },
			{ name: "Garde Infernal", quantity: 2 },
			{ name: "Bourreau Mineur", quantity: 3 },
			{ name: "Chevalier Déchu", quantity: 3 },
			{ name: "Émissaire du Pacte", quantity: 2 },
			{ name: "Vague de Corruption", quantity: 2 },
			{ name: "Cavalier des Flammes", quantity: 2 },
			{ name: "Le Corrupteur", quantity: 1 },
			{ name: "Fragment de Pacte", quantity: 10 },
		],
	},
	{
		race: "Abomination",
		deckName: "Deck de départ — Abomination",
		entries: [
			{ name: "Amas Informe", quantity: 4 },
			{ name: "Cœur Sans Corps", quantity: 3 },
			{ name: "Semence Amère", quantity: 2 },
			{ name: "Premier Tressaut", quantity: 2 },
			{ name: "Nœud de Chair", quantity: 4 },
			{ name: "Peau-Trop-Grande", quantity: 3 },
			{ name: "Regard Détaché", quantity: 2 },
			{ name: "Morsure de l'Air", quantity: 2 },
			{ name: "Un-Devenu-Plusieurs", quantity: 3 },
			{ name: "Le Poids-Qui-Marche", quantity: 3 },
			{ name: "Visage-Encore-Flou", quantity: 2 },
			{ name: "Pluie Qui Change", quantity: 2 },
			{ name: "Bouche-Mère", quantity: 2 },
			{ name: "Second Regard", quantity: 2 },
			{ name: "Masse-Qui-Ne-Cesse", quantity: 2 },
			{ name: "Ce-Qui-A-Trop-Poussé", quantity: 2 },
			{ name: "Éclat d'Anomalie", quantity: 10 },
		],
	},
];
