import type { RowDataPacket } from "mysql2";
import db from "./db";
import { credit, getBalance, creditFreePacks, getFreePacks } from "./currencyModel";

// Même principe que weeklyQuestModel (catalogue en code, rotation par slot,
// reset périodique) mais objectifs nettement plus longs et récompense
// double (or + packs, comme uniqueQuestModel) pour marquer le coup une fois
// par mois — voir "Quêtes mensuelles" dans CLAUDE.md.
interface MonthlyQuestTemplate {
	code: string;
	objective: "play" | "win" | "win_network" | "play_race" | "play_multirace";
	target: number;
	rewardCurrency: number;
	rewardPack: number;
	descriptionKey: string;
	// Uniquement pour play_race : nom de race tel qu'utilisé côté client
	// (Race.get_race_name — "Human"/"Undead"/"Demon"/"Abomination").
	race?: string;
}

const IMPLEMENTED_RACES = ["Human", "Undead", "Demon", "Abomination"] as const;

const raceQuestTemplates = (): MonthlyQuestTemplate[] =>
	IMPLEMENTED_RACES.map((race) => ({
		code: `play_race_${race.toLowerCase()}_60`,
		objective: "play_race" as const,
		race,
		target: 60,
		rewardCurrency: 600,
		rewardPack: 2,
		descriptionKey: `QUEST_MONTHLY_PLAY_RACE_${race.toUpperCase()}_60`,
	}));

const MONTHLY_QUEST_TEMPLATES: MonthlyQuestTemplate[] = [
	{ code: "play_100", objective: "play", target: 100, rewardCurrency: 500, rewardPack: 2, descriptionKey: "QUEST_MONTHLY_PLAY_100" },
	{ code: "win_50", objective: "win", target: 50, rewardCurrency: 700, rewardPack: 3, descriptionKey: "QUEST_MONTHLY_WIN_50" },
	{
		code: "win_network_30",
		objective: "win_network",
		target: 30,
		rewardCurrency: 800,
		rewardPack: 3,
		descriptionKey: "QUEST_MONTHLY_WIN_NETWORK_30",
	},
	{
		code: "play_multirace_25",
		objective: "play_multirace",
		target: 25,
		rewardCurrency: 600,
		rewardPack: 2,
		descriptionKey: "QUEST_MONTHLY_PLAY_MULTIRACE_25",
	},
	...raceQuestTemplates(),
];

const QUESTS_PER_MONTH = 2;

interface MonthlyQuestRow extends RowDataPacket {
	id: number;
	user_id: number;
	month_start: string;
	slot: number;
	quest_code: string;
	progress: number;
	target: number;
	reward_currency: number;
	reward_pack: number;
	claimed_at: string | null;
}

interface MonthlyQuestsResponse {
	quests: {
		id: number;
		description_key: string;
		progress: number;
		target: number;
		reward_currency: number;
		reward_pack: number;
		claimed: boolean;
	}[];
	resets_at: string;
}

class MonthlyQuestNotFoundError extends Error {
	constructor() {
		super("Quête introuvable");
		this.name = "MonthlyQuestNotFoundError";
	}
}

class MonthlyQuestNotCompletedError extends Error {
	constructor() {
		super("Quête pas encore terminée");
		this.name = "MonthlyQuestNotCompletedError";
	}
}

class MonthlyQuestAlreadyClaimedError extends Error {
	constructor() {
		super("Récompense déjà réclamée");
		this.name = "MonthlyQuestAlreadyClaimedError";
	}
}

const templateByCode = (code: string): MonthlyQuestTemplate | undefined =>
	MONTHLY_QUEST_TEMPLATES.find((template) => template.code === code);

// Numéro de mois écoulé depuis l'epoch : sert uniquement de graine de
// rotation (pas exposée), n'a pas besoin de s'aligner sur le 1er du mois
// exact utilisé côté SQL pour month_start — seule la stabilité sur un mois
// calendaire compte (un utilisateur peut voir son slot changer autour d'un
// changement de fuseau horaire proche du 1er du mois, sans conséquence).
const monthNumber = (): number => {
	const now = new Date();
	return now.getUTCFullYear() * 12 + now.getUTCMonth();
};

const pickTemplatesFor = (userId: number, month: number): MonthlyQuestTemplate[] => {
	const seed = userId + month;
	const picked: MonthlyQuestTemplate[] = [];
	for (let slot = 0; slot < QUESTS_PER_MONTH; slot++) {
		picked.push(MONTHLY_QUEST_TEMPLATES[(seed + slot) % MONTHLY_QUEST_TEMPLATES.length]);
	}
	return picked;
};

// month_start calculé côté SQL (1er du mois courant) pour rester cohérent
// quel que soit le fuseau du serveur — jamais une date calculée côté JS.
const MONTH_START_SQL = "DATE(DATE_FORMAT(CURDATE(), '%Y-%m-01'))";

const ensureThisMonthQuests = async (userId: number): Promise<MonthlyQuestRow[]> => {
	const templates = pickTemplatesFor(userId, monthNumber());
	for (let slot = 0; slot < templates.length; slot++) {
		const template = templates[slot];
		await db.query(
			`INSERT INTO monthly_quests (user_id, month_start, slot, quest_code, progress, target, reward_currency, reward_pack)
			 VALUES (?, ${MONTH_START_SQL}, ?, ?, 0, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE user_id = user_id`,
			[userId, slot, template.code, template.target, template.rewardCurrency, template.rewardPack],
		);
	}
	const [rows] = await db.query<MonthlyQuestRow[]>(
		`SELECT * FROM monthly_quests WHERE user_id = ? AND month_start = ${MONTH_START_SQL} ORDER BY slot`,
		[userId],
	);
	return rows;
};

const getMonthlyQuests = async (userId: number): Promise<MonthlyQuestsResponse> => {
	const quests = await ensureThisMonthQuests(userId);

	const resetsAt = new Date();
	resetsAt.setUTCMonth(resetsAt.getUTCMonth() + 1, 1);
	resetsAt.setUTCHours(0, 0, 0, 0);

	return {
		quests: quests.map((quest) => ({
			id: quest.id,
			description_key: templateByCode(quest.quest_code)?.descriptionKey ?? quest.quest_code,
			progress: quest.progress,
			target: quest.target,
			reward_currency: quest.reward_currency,
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

// Fait progresser les quêtes mensuelles actives concernées par ce résultat
// de match — même point d'entrée que questModel.progressForMatch/
// weeklyQuestModel.progressForMatch (appelé juste à côté, depuis les mêmes
// controllers, aucune nouvelle télémétrie).
const progressForMatch = async (
	userId: number,
	mode: "solo" | "ranked",
	won: boolean,
	raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureThisMonthQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "play") {
			await db.query("UPDATE monthly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "win" && won) {
			await db.query("UPDATE monthly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "win_network" && won && mode === "ranked") {
			await db.query("UPDATE monthly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_race" && template.race) {
			const count = raceData.cardsPlayedByRace?.[template.race] ?? 0;
			if (count <= 0) continue;
			await db.query("UPDATE monthly_quests SET progress = LEAST(progress + ?, target) WHERE id = ?", [count, quest.id]);
		} else if (template.objective === "play_multirace") {
			if ((raceData.deckRaces?.length ?? 0) < 2) continue;
			await db.query("UPDATE monthly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		}
	}
};

const claimMonthlyQuest = async (
	userId: number,
	questId: number,
): Promise<{ balance: number; free_packs: number; reward_currency: number; reward_pack: number }> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		const [rows] = await connection.query<MonthlyQuestRow[]>(
			"SELECT * FROM monthly_quests WHERE id = ? AND user_id = ? FOR UPDATE",
			[questId, userId],
		);
		const quest = rows[0];
		if (!quest) throw new MonthlyQuestNotFoundError();
		if (quest.claimed_at !== null) throw new MonthlyQuestAlreadyClaimedError();
		if (quest.progress < quest.target) throw new MonthlyQuestNotCompletedError();

		await connection.query("UPDATE monthly_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		if (quest.reward_currency > 0) {
			await credit(userId, quest.reward_currency, "monthly_quest", String(questId), connection);
		}
		if (quest.reward_pack > 0) await creditFreePacks(userId, quest.reward_pack, connection);

		await connection.commit();
		return {
			balance: await getBalance(userId),
			free_packs: await getFreePacks(userId),
			reward_currency: quest.reward_currency,
			reward_pack: quest.reward_pack,
		};
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export {
	MONTHLY_QUEST_TEMPLATES,
	MonthlyQuestNotFoundError,
	MonthlyQuestNotCompletedError,
	MonthlyQuestAlreadyClaimedError,
	ensureThisMonthQuests,
	getMonthlyQuests,
	progressForMatch,
	claimMonthlyQuest,
};
