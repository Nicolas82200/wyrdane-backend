import type { RowDataPacket } from "mysql2";
import db from "./db";
import { credit, getBalance } from "./currencyModel";
import { applyXp } from "./levelModel";
import { countsForMatchQuests, type QuestMatchMode } from "./questMatchMode";

// Catalogue des quêtes possibles : en code plutôt qu'en table, même logique
// que les montants de récompense dans rewardsController (config figée par
// déploiement, pas une donnée éditable en base). daily_quests ne stocke que
// l'assignation/progression par joueur, pas la définition de la quête.
interface QuestTemplate {
	code: string;
	objective: "play" | "win" | "login" | "play_resource_race";
	target: number;
	rewardCurrency: number;
	rewardXp: number;
	descriptionKey: string;
	// Uniquement pour play_resource_race : nom de race tel qu'utilisé côté
	// client (Race.get_race_name — "Human"/"Undead"/"Demon"/"Abomination").
	race?: string;
}

// Races jouables (voir Race.get_implemented_races côté client), dans l'ordre
// de rotation de la quête-ressource du jour.
const IMPLEMENTED_RACES = ["Undead", "Human", "Demon", "Abomination"] as const;

// Refonte du 2026-11-02 : plus de tirage parmi un grand catalogue, mais
// QUESTS_PER_DAY quêtes FIXES assignées à tout le monde chaque jour. La
// rotation d'avant (3 tirées parmi 13, graine userId + jour) avait une période
// de 13 jours — un joueur revoyait la même séquence à l'identique — et
// imposait au hasard des quêtes de race invalidables pour un deck mono-race.
// Seule la quête-ressource tourne désormais, sur la race du jour, et elle est
// la même pour tous les joueurs.
//
// Trois quêtes paient en or, une en XP (la quête-ressource) : voir
// docs/economy.md pour le barème complet et le revenu attendu.
const FIXED_DAILY_TEMPLATES: QuestTemplate[] = [
	{ code: "play_3", objective: "play", target: 3, rewardCurrency: 50, rewardXp: 0, descriptionKey: "QUEST_PLAY_3" },
	{ code: "win_1", objective: "win", target: 1, rewardCurrency: 50, rewardXp: 0, descriptionKey: "QUEST_WIN_1" },
	{ code: "login_1", objective: "login", target: 1, rewardCurrency: 50, rewardXp: 0, descriptionKey: "QUEST_LOGIN_1" },
];

// Quête-ressource du jour : même race pour tous les joueurs, elle change
// chaque jour (la graine ne contient volontairement pas l'userId).
const resourceQuestTemplate = (day: number): QuestTemplate => {
	const race = IMPLEMENTED_RACES[day % IMPLEMENTED_RACES.length];
	return {
		code: `play_resource_${race.toLowerCase()}_10`,
		objective: "play_resource_race",
		race,
		target: 10,
		rewardCurrency: 0,
		rewardXp: 25,
		descriptionKey: `QUEST_PLAY_RESOURCE_${race.toUpperCase()}_10`,
	};
};

// Tous les templates qu'un jour peut produire — sert à retrouver le template
// d'une ligne en base, y compris celle d'hier (la quête-ressource d'un autre
// jour) tant qu'elle n'a pas été purgée.
const QUEST_TEMPLATES: QuestTemplate[] = [
	...FIXED_DAILY_TEMPLATES,
	...IMPLEMENTED_RACES.map((_, index) => resourceQuestTemplate(index)),
];

const QUESTS_PER_DAY = 4;

interface DailyQuestRow extends RowDataPacket {
	id: number;
	user_id: number;
	quest_date: string;
	slot: number;
	quest_code: string;
	progress: number;
	target: number;
	reward_currency: number;
	reward_xp: number;
	claimed_at: string | null;
}

interface DailyQuestsResponse {
	quests: {
		id: number;
		description_key: string;
		progress: number;
		target: number;
		reward_currency: number;
		reward_xp: number;
		claimed: boolean;
	}[];
	resets_at: string;
}

class QuestNotFoundError extends Error {
	constructor() {
		super("Quête introuvable");
		this.name = "QuestNotFoundError";
	}
}

class QuestNotCompletedError extends Error {
	constructor() {
		super("Quête pas encore terminée");
		this.name = "QuestNotCompletedError";
	}
}

class QuestAlreadyClaimedError extends Error {
	constructor() {
		super("Récompense déjà réclamée");
		this.name = "QuestAlreadyClaimedError";
	}
}

const templateByCode = (code: string): QuestTemplate | undefined =>
	QUEST_TEMPLATES.find((template) => template.code === code);

// Nombre de jours écoulés depuis l'epoch (heure serveur) : sert de graine de
// rotation de la quête-ressource, pas de vraie date affichée.
const dayNumber = (): number => Math.floor(Date.now() / 86400000);

// Les quêtes du jour : les trois fixes, puis la quête-ressource du jour.
const templatesForDay = (day: number): QuestTemplate[] => [
	...FIXED_DAILY_TEMPLATES,
	resourceQuestTemplate(day),
];

// Assigne les QUESTS_PER_DAY quêtes du jour au premier appel de la journée pour ce joueur
// (paresseux, même pattern que rankedModel.getStats/solo_stats.getStats),
// puis les renvoie — idempotent, un second appel le même jour ne change rien.
const ensureTodayQuests = async (userId: number): Promise<DailyQuestRow[]> => {
	const templates = templatesForDay(dayNumber());
	for (let slot = 0; slot < templates.length; slot++) {
		const template = templates[slot];
		await db.query(
			`INSERT INTO daily_quests (user_id, quest_date, slot, quest_code, progress, target, reward_currency, reward_xp)
			 VALUES (?, CURDATE(), ?, ?, 0, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE user_id = user_id`,
			[userId, slot, template.code, template.target, template.rewardCurrency, template.rewardXp],
		);
	}
	const [rows] = await db.query<DailyQuestRow[]>(
		"SELECT * FROM daily_quests WHERE user_id = ? AND quest_date = CURDATE() ORDER BY slot",
		[userId],
	);
	return rows;
};

const getDailyQuests = async (userId: number): Promise<DailyQuestsResponse> => {
	const quests = await ensureTodayQuests(userId);
	const resetsAt = new Date();
	resetsAt.setUTCHours(24, 0, 0, 0); // minuit prochain, cohérent avec CURDATE() côté serveur

	return {
		quests: quests.map((quest) => ({
			id: quest.id,
			description_key: templateByCode(quest.quest_code)?.descriptionKey ?? quest.quest_code,
			progress: quest.progress,
			target: quest.target,
			reward_currency: quest.reward_currency,
			reward_xp: quest.reward_xp ?? 0,
			claimed: quest.claimed_at !== null,
		})),
		resets_at: resetsAt.toISOString(),
	};
};

interface MatchRaceData {
	// Nombre de cartes jouées pendant le match, par race — alimente les
	// quêtes play_race (hebdomadaires/mensuelles) quel que soit le résultat.
	cardsPlayedByRace?: Record<string, number>;
	// Nombre de cartes-RESSOURCE jouées pendant le match, par race, compté à
	// part de cardsPlayedByRace : une quête « jouez 10 Sceaux » ne doit pas
	// être validée par des serviteurs Humains, ni l'inverse.
	resourceCardsByRace?: Record<string, number>;
	// Races présentes dans le deck utilisé pour ce match — alimente les
	// quêtes win_race, uniquement sur une victoire.
	deckRaces?: string[];
}

// Fait progresser les quêtes actives concernées par ce résultat de match
// (play_*/play_race_* toujours, win_*/win_ranked_*/win_race_* seulement en
// cas de victoire) — appelé une fois par joueur et par match confirmé,
// depuis rewardsController (solo) et rankedController (classé, pour les deux
// joueurs, avec les données de race déclarées par chacun). Ignore les
// quêtes déjà au maximum ou déjà réclamées.
const progressForMatch = async (
	userId: number,
	mode: QuestMatchMode,
	won: boolean,
	raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureTodayQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "play" || template.objective === "win") {
			// Ni l'IA ni une invitation d'ami ne comptent (voir questMatchMode).
			if (!countsForMatchQuests(mode)) continue;
			if (template.objective === "win" && !won) continue;
			await db.query("UPDATE daily_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_resource_race" && template.race) {
			// Cartes-ressource uniquement, comptées dans TOUS les modes : rien
			// n'empêche de les jouer contre l'IA, et il n'y a rien à y gagner
			// d'autre que la quête.
			const count = raceData.resourceCardsByRace?.[template.race] ?? 0;
			if (count <= 0) continue;
			await db.query("UPDATE daily_quests SET progress = LEAST(progress + ?, target) WHERE id = ?", [count, quest.id]);
		}
	}
};

// Progression de la quête de connexion du jour — appelée à chaque
// authentification réussie (authController.loginWithSteamId), jamais depuis un
// résultat de match. Remplace la popup de récompense de connexion, désormais
// une simple ligne de l'onglet Quêtes (décision produit 2026-11-02).
const progressForLogin = async (userId: number): Promise<void> => {
	const quests = await ensureTodayQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		if (templateByCode(quest.quest_code)?.objective !== "login") continue;
		await db.query("UPDATE daily_quests SET progress = target WHERE id = ?", [quest.id]);
	}
};

// Verrouille la ligne (FOR UPDATE) pour qu'un double-clic/double-appel réseau
// ne puisse jamais créditer deux fois la même quête — même garde-fou que
// currencyModel.debit.
const claimQuest = async (
	userId: number,
	questId: number,
): Promise<{ balance: number; reward_currency: number; reward_xp: number }> => {
	const connection = await db.getConnection();
	let rewardXp = 0;
	try {
		await connection.beginTransaction();

		const [rows] = await connection.query<DailyQuestRow[]>(
			"SELECT * FROM daily_quests WHERE id = ? AND user_id = ? FOR UPDATE",
			[questId, userId],
		);
		const quest = rows[0];
		if (!quest) throw new QuestNotFoundError();
		if (quest.claimed_at !== null) throw new QuestAlreadyClaimedError();
		if (quest.progress < quest.target) throw new QuestNotCompletedError();

		rewardXp = quest.reward_xp ?? 0;
		await connection.query("UPDATE daily_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		if (quest.reward_currency > 0) {
			await credit(userId, quest.reward_currency, "daily_quest_claim", String(questId), connection);
		}
		// L'XP est créditée DANS la transaction : un passage de niveau octroie
		// une récompense de palier (carte/pack/or), qui doit vivre ou mourir
		// avec la réclamation elle-même.
		if (rewardXp > 0) await applyXp(userId, rewardXp, connection);

		await connection.commit();
		return { balance: await getBalance(userId), reward_currency: quest.reward_currency, reward_xp: rewardXp };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export {
	QUEST_TEMPLATES,
	QUESTS_PER_DAY,
	QuestNotFoundError,
	QuestNotCompletedError,
	QuestAlreadyClaimedError,
	ensureTodayQuests,
	getDailyQuests,
	progressForMatch,
	progressForLogin,
	claimQuest,
};
