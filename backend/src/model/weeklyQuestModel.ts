import type { RowDataPacket } from "mysql2";
import db from "./db";
import { credit, creditFreePacks, getBalance, getFreePacks } from "./currencyModel";
import { applyXp } from "./levelModel";
import { countsForMatchQuests, type QuestMatchMode } from "./questMatchMode";

// Même principe que questModel (catalogue en code, pas en base) mais objectifs
// hebdomadaires, reset chaque lundi (voir week_start dans weekly_quests).
//
// Refonte du 2026-11-02 : QUESTS_PER_WEEK passe de 1 à 5 quêtes FIXES, plus
// aucun tirage. Avec une seule quête tirée parmi 7, six templates sur sept ne
// se montraient jamais une semaine donnée, et la quête de race pouvait tomber
// sur une race que le joueur ne joue pas — invalidable, sans recours. Seule la
// quête de race tourne désormais, sur la race de la semaine, identique pour
// tous les joueurs.
//
// Les quêtes de parties ne comptent que le multijoueur apparié (voir
// questMatchMode.countsForMatchQuests). Barème et revenu attendu :
// docs/economy.md.
interface WeeklyQuestTemplate {
	code: string;
	objective: "play" | "win" | "play_race" | "login_days";
	target: number;
	rewardCurrency: number;
	rewardPack: number;
	rewardXp: number;
	descriptionKey: string;
	// Uniquement pour play_race : nom de race tel qu'utilisé côté client
	// (Race.get_race_name — "Human"/"Undead"/"Demon"/"Abomination").
	race?: string;
}

const IMPLEMENTED_RACES = ["Undead", "Human", "Demon", "Abomination"] as const;

const FIXED_WEEKLY_TEMPLATES: WeeklyQuestTemplate[] = [
	{
		code: "play_20",
		objective: "play",
		target: 20,
		rewardCurrency: 150,
		rewardPack: 0,
		rewardXp: 0,
		descriptionKey: "QUEST_WEEKLY_PLAY_20",
	},
	{
		code: "play_40",
		objective: "play",
		target: 40,
		rewardCurrency: 300,
		rewardPack: 0,
		rewardXp: 0,
		descriptionKey: "QUEST_WEEKLY_PLAY_40",
	},
	{
		code: "win_15",
		objective: "win",
		target: 15,
		rewardCurrency: 250,
		rewardPack: 1,
		rewardXp: 0,
		descriptionKey: "QUEST_WEEKLY_WIN_15",
	},
	{
		code: "login_days_7",
		objective: "login_days",
		target: 7,
		rewardCurrency: 200,
		rewardPack: 0,
		rewardXp: 100,
		descriptionKey: "QUEST_WEEKLY_LOGIN_DAYS_7",
	},
];

// Quête de race de la semaine : même race pour tous les joueurs, elle change
// chaque semaine (la graine ne contient volontairement pas l'userId).
const raceQuestTemplate = (week: number): WeeklyQuestTemplate => {
	const race = IMPLEMENTED_RACES[week % IMPLEMENTED_RACES.length];
	return {
		code: `play_race_${race.toLowerCase()}_100`,
		objective: "play_race",
		race,
		target: 100,
		rewardCurrency: 200,
		rewardPack: 0,
		rewardXp: 0,
		descriptionKey: `QUEST_WEEKLY_PLAY_RACE_${race.toUpperCase()}_100`,
	};
};

// Tous les templates qu'une semaine peut produire — sert à retrouver le
// template d'une ligne en base, y compris la quête de race d'une autre
// semaine encore présente.
const WEEKLY_QUEST_TEMPLATES: WeeklyQuestTemplate[] = [
	...FIXED_WEEKLY_TEMPLATES,
	...IMPLEMENTED_RACES.map((_, index) => raceQuestTemplate(index)),
];

const templatesForWeek = (week: number): WeeklyQuestTemplate[] => [
	...FIXED_WEEKLY_TEMPLATES,
	raceQuestTemplate(week),
];

const QUESTS_PER_WEEK = FIXED_WEEKLY_TEMPLATES.length + 1;

interface WeeklyQuestRow extends RowDataPacket {
	id: number;
	user_id: number;
	week_start: string;
	slot: number;
	quest_code: string;
	progress: number;
	target: number;
	reward_pack: number;
	reward_currency: number;
	reward_xp: number;
	last_progress_date: string | null;
	claimed_at: string | null;
}

interface WeeklyQuestsResponse {
	quests: {
		id: number;
		description_key: string;
		progress: number;
		target: number;
		reward_pack: number;
		reward_currency: number;
		reward_xp: number;
		claimed: boolean;
	}[];
	resets_at: string;
}

class WeeklyQuestNotFoundError extends Error {
	constructor() {
		super("Quête introuvable");
		this.name = "WeeklyQuestNotFoundError";
	}
}

class WeeklyQuestNotCompletedError extends Error {
	constructor() {
		super("Quête pas encore terminée");
		this.name = "WeeklyQuestNotCompletedError";
	}
}

class WeeklyQuestAlreadyClaimedError extends Error {
	constructor() {
		super("Récompense déjà réclamée");
		this.name = "WeeklyQuestAlreadyClaimedError";
	}
}

const templateByCode = (code: string): WeeklyQuestTemplate | undefined =>
	WEEKLY_QUEST_TEMPLATES.find((template) => template.code === code);

// Nombre de semaines écoulées depuis l'epoch : sert uniquement de graine de
// rotation (pas exposée), n'a pas besoin de s'aligner sur le lundi exact
// utilisé côté SQL pour week_start — seule la stabilité sur 7 jours compte.
const weekNumber = (): number => Math.floor(Date.now() / (7 * 86400000));

// week_start calculé côté SQL (lundi de la semaine courante, WEEKDAY()
// renvoie 0=lundi..6=dimanche) pour rester cohérent quel que soit le fuseau
// du serveur — jamais une date calculée côté JS.
const WEEK_START_SQL = "DATE(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY))";

const ensureThisWeekQuests = async (userId: number): Promise<WeeklyQuestRow[]> => {
	const templates = templatesForWeek(weekNumber());
	for (let slot = 0; slot < templates.length; slot++) {
		const template = templates[slot];
		await db.query(
			`INSERT INTO weekly_quests
			   (user_id, week_start, slot, quest_code, progress, target, reward_pack, reward_currency, reward_xp)
			 VALUES (?, ${WEEK_START_SQL}, ?, ?, 0, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE user_id = user_id`,
			[
				userId,
				slot,
				template.code,
				template.target,
				template.rewardPack,
				template.rewardCurrency,
				template.rewardXp,
			],
		);
	}
	const [rows] = await db.query<WeeklyQuestRow[]>(
		`SELECT * FROM weekly_quests WHERE user_id = ? AND week_start = ${WEEK_START_SQL} ORDER BY slot`,
		[userId],
	);
	return rows;
};

const getWeeklyQuests = async (userId: number): Promise<WeeklyQuestsResponse> => {
	const quests = await ensureThisWeekQuests(userId);

	const resetsAt = new Date();
	const day = resetsAt.getUTCDay(); // 0=dimanche..6=samedi
	const daysUntilNextMonday = ((1 - day + 7) % 7) || 7;
	resetsAt.setUTCDate(resetsAt.getUTCDate() + daysUntilNextMonday);
	resetsAt.setUTCHours(0, 0, 0, 0);

	return {
		quests: quests.map((quest) => ({
			id: quest.id,
			description_key: templateByCode(quest.quest_code)?.descriptionKey ?? quest.quest_code,
			progress: quest.progress,
			target: quest.target,
			reward_pack: quest.reward_pack,
			reward_currency: quest.reward_currency ?? 0,
			reward_xp: quest.reward_xp ?? 0,
			claimed: quest.claimed_at !== null,
		})),
		resets_at: resetsAt.toISOString(),
	};
};

interface MatchRaceData {
	cardsPlayedByRace?: Record<string, number>;
	// Races présentes dans le deck utilisé pour ce match — alimente
	// play_multirace, peu importe le résultat.
	deckRaces?: string[];
}

// Fait progresser les quêtes hebdo actives concernées par ce résultat de
// match — même point d'entrée que questModel.progressForMatch (appelé juste
// à côté, depuis les mêmes controllers, aucune nouvelle télémétrie).
const progressForMatch = async (
	userId: number,
	mode: QuestMatchMode,
	won: boolean,
	raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureThisWeekQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "play" || template.objective === "win") {
			// Ni l'IA ni une invitation d'ami ne comptent (voir questMatchMode).
			if (!countsForMatchQuests(mode)) continue;
			if (template.objective === "win" && !won) continue;
			await db.query("UPDATE weekly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_race" && template.race) {
			// Compte des CARTES de cette race, pas des parties — les cartes
			// -ressource sont exclues, elles ont leur propre quête quotidienne.
			const count = raceData.cardsPlayedByRace?.[template.race] ?? 0;
			if (count <= 0) continue;
			await db.query("UPDATE weekly_quests SET progress = LEAST(progress + ?, target) WHERE id = ?", [count, quest.id]);
		}
	}
};

// Progression de la quête « connectez-vous 7 jours » : un seul pas par jour
// civil, d'où last_progress_date — sans elle, sept connexions le même jour
// valideraient la quête.
const progressForLogin = async (userId: number): Promise<void> => {
	const quests = await ensureThisWeekQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		if (templateByCode(quest.quest_code)?.objective !== "login_days") continue;
		await db.query(
			`UPDATE weekly_quests
			 SET progress = LEAST(progress + 1, target), last_progress_date = CURDATE()
			 WHERE id = ? AND (last_progress_date IS NULL OR last_progress_date < CURDATE())`,
			[quest.id],
		);
	}
};

const claimWeeklyQuest = async (
	userId: number,
	questId: number,
): Promise<{ free_packs: number; reward_pack: number; balance: number; reward_currency: number; reward_xp: number }> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		const [rows] = await connection.query<WeeklyQuestRow[]>(
			"SELECT * FROM weekly_quests WHERE id = ? AND user_id = ? FOR UPDATE",
			[questId, userId],
		);
		const quest = rows[0];
		if (!quest) throw new WeeklyQuestNotFoundError();
		if (quest.claimed_at !== null) throw new WeeklyQuestAlreadyClaimedError();
		if (quest.progress < quest.target) throw new WeeklyQuestNotCompletedError();

		const rewardCurrency = quest.reward_currency ?? 0;
		const rewardXp = quest.reward_xp ?? 0;
		await connection.query("UPDATE weekly_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		if (quest.reward_pack > 0) await creditFreePacks(userId, quest.reward_pack, connection);
		if (rewardCurrency > 0) {
			await credit(userId, rewardCurrency, "weekly_quest_claim", String(questId), connection);
		}
		// Dans la transaction : un passage de niveau octroie une récompense de
		// palier, qui doit vivre ou mourir avec la réclamation.
		if (rewardXp > 0) await applyXp(userId, rewardXp, connection);

		await connection.commit();
		return {
			free_packs: await getFreePacks(userId),
			reward_pack: quest.reward_pack,
			balance: await getBalance(userId),
			reward_currency: rewardCurrency,
			reward_xp: rewardXp,
		};
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export {
	WEEKLY_QUEST_TEMPLATES,
	QUESTS_PER_WEEK,
	WeeklyQuestNotFoundError,
	WeeklyQuestNotCompletedError,
	WeeklyQuestAlreadyClaimedError,
	ensureThisWeekQuests,
	getWeeklyQuests,
	progressForMatch,
	progressForLogin,
	claimWeeklyQuest,
};
