// Borne les données de match auto-déclarées par le client (cardsPlayedByRace,
// deckRaces) avant qu'elles n'alimentent la progression des quêtes — voir
// rewardsController.reportSoloMatch et rankedController.reportMatch. N'empêche
// pas un client de mentir sur le RÉSULTAT d'un match (aucune preuve serveur
// qu'une vraie partie a eu lieu, limitation connue — voir le rate-limiting
// appliqué sur ces routes en complément), mais empêche au moins un payload
// absurde (compteur à 999999, race inexistante) de fausser plusieurs quêtes
// d'un coup ou de planter une requête SQL sur une valeur non bornée.

// Races jouables (doit rester synchronisé avec
// questModel.IMPLEMENTED_RACES / Race.get_implemented_races côté client).
const IMPLEMENTED_RACES = ["Human", "Undead", "Demon", "Abomination"] as const;

// Un deck compte au maximum une centaine de cartes jouables (voir
// ACH_MEGA_DECK côté client, deck "mega" > 100) : aucune carte d'une race ne
// peut raisonnablement être jouée plus de fois que ça en un seul match.
const MAX_CARDS_PLAYED_PER_RACE = 200;

const sanitizeCardsPlayedByRace = (
	value: Record<string, number> | undefined,
): Record<string, number> | undefined => {
	if (!value || typeof value !== "object") return undefined;
	const sanitized: Record<string, number> = {};
	for (const race of IMPLEMENTED_RACES) {
		const count = value[race];
		if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
		sanitized[race] = Math.min(Math.floor(count), MAX_CARDS_PLAYED_PER_RACE);
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

const sanitizeDeckRaces = (value: string[] | undefined): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const sanitized = [...new Set(value.filter((race): race is string => (IMPLEMENTED_RACES as readonly string[]).includes(race)))];
	return sanitized.length > 0 ? sanitized : undefined;
};

// Borne la liste des cartes posées déclarée par le client (voir
// docs/backend-contracts/card-stats-and-leaderboard.md côté card-game) avant
// qu'elle n'alimente card_play_stats — même logique défensive que
// sanitizeCardsPlayedByRace : un payload absurde ne doit pas pouvoir gonfler
// une requête SQL ou polluer les stats d'équilibrage. Même borne que
// MAX_CARDS_PLAYED_PER_RACE (un deck ne dépasse pas une centaine de cartes
// jouables, voir ACH_MEGA_DECK) mais appliquée au total, pas par race.
const MAX_CARDS_PLAYED_TOTAL = 200;
const MAX_CARD_NAME_LENGTH = 100;

const sanitizeCardsPlayed = (value: string[] | undefined): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const sanitized = value
		.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= MAX_CARD_NAME_LENGTH)
		.slice(0, MAX_CARDS_PLAYED_TOTAL);
	return sanitized.length > 0 ? sanitized : undefined;
};

// Durée déclarée par le client pour ce match (secondes) — alimente
// l'historique de parties du profil (match_history.duration_sec). Bornée à
// 3h : un match Wyrdane normal dure quelques minutes, une valeur au-delà est
// forcément un payload aberrant (jamais rejetée pour autant, juste ignorée).
const MAX_DURATION_SEC = 3 * 60 * 60;

const sanitizeDurationSec = (value: number | undefined): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.floor(value), MAX_DURATION_SEC);
};

export { IMPLEMENTED_RACES, sanitizeCardsPlayedByRace, sanitizeDeckRaces, sanitizeCardsPlayed, sanitizeDurationSec };
