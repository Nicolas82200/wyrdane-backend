import type { RowDataPacket } from "mysql2";
import db from "./db";
import { creditFreePacks, getFreePacks } from "./currencyModel";

// Même principe que questModel.QUEST_TEMPLATES (catalogue en code, pas en
// base) mais objectifs plus longs et récompense en packs plutôt qu'en or,
// reset chaque lundi (voir week_start dans weekly_quests).
//
// "win_network" réutilise le mode "ranked" déjà transmis à progressForMatch
// pour TOUT match réseau (classé ou partie rapide — voir rankedController.
// reportMatch, qui ne distingue actuellement pas les deux). Objectif
// "win_ranked_only" volontairement absent : impossible de le distinguer
// honnêtement d'un match réseau non classé avec les données actuelles.
interface WeeklyQuestTemplate {
	code: string;
	objective: "play" | "win_network" | "play_race" | "play_multirace";
	target: number;
	rewardPack: number;
	descriptionKey: string;
	// Uniquement pour play_race : nom de race tel qu'utilisé côté client
	// (Race.get_race_name — "Human"/"Undead"/"Demon"/"Abomination").
	race?: string;
}

const IMPLEMENTED_RACES = ["Human", "Undead", "Demon", "Abomination"] as const;

const raceQuestTemplates = (): WeeklyQuestTemplate[] =>
	IMPLEMENTED_RACES.map((race) => ({
		code: `play_race_${race.toLowerCase()}_15`,
		objective: "play_race" as const,
		race,
		target: 15,
		rewardPack: 1,
		descriptionKey: `QUEST_WEEKLY_PLAY_RACE_${race.toUpperCase()}_15`,
	}));

const WEEKLY_QUEST_TEMPLATES: WeeklyQuestTemplate[] = [
	{ code: "play_30", objective: "play", target: 30, rewardPack: 1, descriptionKey: "QUEST_WEEKLY_PLAY_30" },
	{ code: "win_network_10", objective: "win_network", target: 10, rewardPack: 2, descriptionKey: "QUEST_WEEKLY_WIN_NETWORK_10" },
	{
		code: "play_multirace_10",
		objective: "play_multirace",
		target: 10,
		rewardPack: 2,
		descriptionKey: "QUEST_WEEKLY_PLAY_MULTIRACE_10",
	},
	...raceQuestTemplates(),
];

const QUESTS_PER_WEEK = 1;

interface WeeklyQuestRow extends RowDataPacket {
	id: number;
	user_id: number;
	week_start: string;
	slot: number;
	quest_code: string;
	progress: number;
	target: number;
	reward_pack: number;
	claimed_at: string | null;
}

interface WeeklyQuestsResponse {
	quests: {
		id: number;
		description_key: string;
		progress: number;
		target: number;
		reward_pack: number;
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

const pickTemplatesFor = (userId: number, week: number): WeeklyQuestTemplate[] => {
	const seed = userId + week;
	const picked: WeeklyQuestTemplate[] = [];
	for (let slot = 0; slot < QUESTS_PER_WEEK; slot++) {
		picked.push(WEEKLY_QUEST_TEMPLATES[(seed + slot) % WEEKLY_QUEST_TEMPLATES.length]);
	}
	return picked;
};

// week_start calculé côté SQL (lundi de la semaine courante, WEEKDAY()
// renvoie 0=lundi..6=dimanche) pour rester cohérent quel que soit le fuseau
// du serveur — jamais une date calculée côté JS.
const WEEK_START_SQL = "DATE(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY))";

const ensureThisWeekQuests = async (userId: number): Promise<WeeklyQuestRow[]> => {
	const templates = pickTemplatesFor(userId, weekNumber());
	for (let slot = 0; slot < templates.length; slot++) {
		const template = templates[slot];
		await db.query(
			`INSERT INTO weekly_quests (user_id, week_start, slot, quest_code, progress, target, reward_pack)
			 VALUES (?, ${WEEK_START_SQL}, ?, ?, 0, ?, ?)
			 ON DUPLICATE KEY UPDATE user_id = user_id`,
			[userId, slot, template.code, template.target, template.rewardPack],
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
	mode: "solo" | "ranked",
	won: boolean,
	raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureThisWeekQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "play") {
			await db.query("UPDATE weekly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "win_network" && won && mode === "ranked") {
			await db.query("UPDATE weekly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_race" && template.race) {
			const count = raceData.cardsPlayedByRace?.[template.race] ?? 0;
			if (count <= 0) continue;
			await db.query("UPDATE weekly_quests SET progress = LEAST(progress + ?, target) WHERE id = ?", [count, quest.id]);
		} else if (template.objective === "play_multirace") {
			if ((raceData.deckRaces?.length ?? 0) < 2) continue;
			await db.query("UPDATE weekly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		}
	}
};

const claimWeeklyQuest = async (
	userId: number,
	questId: number,
): Promise<{ free_packs: number; reward_pack: number }> => {
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

		await connection.query("UPDATE weekly_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		await creditFreePacks(userId, quest.reward_pack, connection);

		await connection.commit();
		return { free_packs: await getFreePacks(userId), reward_pack: quest.reward_pack };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export {
	WEEKLY_QUEST_TEMPLATES,
	WeeklyQuestNotFoundError,
	WeeklyQuestNotCompletedError,
	WeeklyQuestAlreadyClaimedError,
	ensureThisWeekQuests,
	getWeeklyQuests,
	progressForMatch,
	claimWeeklyQuest,
};
