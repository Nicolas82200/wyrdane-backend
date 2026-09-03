import type { RowDataPacket } from "mysql2";
import db from "./db";
import { credit, getBalance } from "./currencyModel";

// Catalogue des quêtes possibles : en code plutôt qu'en table, même logique
// que les montants de récompense dans rewardsController (config figée par
// déploiement, pas une donnée éditable en base). daily_quests ne stocke que
// l'assignation/progression par joueur, pas la définition de la quête.
interface QuestTemplate {
	code: string;
	objective: "play" | "win" | "win_ranked" | "play_race" | "win_race";
	target: number;
	rewardCurrency: number;
	descriptionKey: string;
	// Uniquement pour play_race/win_race : nom de race tel qu'utilisé côté
	// client (Race.get_race_name — "Human"/"Undead"/"Demon"/"Abomination").
	race?: string;
}

// Races jouables (voir Race.get_implemented_races côté client) pour lesquelles
// une paire de quêtes play_race/win_race est générée ci-dessous.
const IMPLEMENTED_RACES = ["Human", "Undead", "Demon", "Abomination"] as const;

const raceQuestTemplates = (): QuestTemplate[] =>
	IMPLEMENTED_RACES.flatMap((race) => [
		{
			code: `play_race_${race.toLowerCase()}_10`,
			objective: "play_race" as const,
			race,
			target: 10,
			rewardCurrency: 40,
			descriptionKey: `QUEST_PLAY_RACE_${race.toUpperCase()}_10`,
		},
		{
			code: `win_race_${race.toLowerCase()}_2`,
			objective: "win_race" as const,
			race,
			target: 2,
			rewardCurrency: 60,
			descriptionKey: `QUEST_WIN_RACE_${race.toUpperCase()}_2`,
		},
	]);

const QUEST_TEMPLATES: QuestTemplate[] = [
	{ code: "play_3", objective: "play", target: 3, rewardCurrency: 30, descriptionKey: "QUEST_PLAY_3" },
	{ code: "play_5", objective: "play", target: 5, rewardCurrency: 60, descriptionKey: "QUEST_PLAY_5" },
	{ code: "win_2", objective: "win", target: 2, rewardCurrency: 50, descriptionKey: "QUEST_WIN_2" },
	{ code: "win_3", objective: "win", target: 3, rewardCurrency: 70, descriptionKey: "QUEST_WIN_3" },
	{ code: "win_ranked_1", objective: "win_ranked", target: 1, rewardCurrency: 80, descriptionKey: "QUEST_WIN_RANKED_1" },
	...raceQuestTemplates(),
];

const QUESTS_PER_DAY = 2;

interface DailyQuestRow extends RowDataPacket {
	id: number;
	user_id: number;
	quest_date: string;
	slot: number;
	quest_code: string;
	progress: number;
	target: number;
	reward_currency: number;
	claimed_at: string | null;
}

interface DailyQuestsResponse {
	quests: {
		id: number;
		description_key: string;
		progress: number;
		target: number;
		reward_currency: number;
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
// rotation, pas de vraie date affichée.
const dayNumber = (): number => Math.floor(Date.now() / 86400000);

// Rotation déterministe (aucun RNG stocké) : pour un joueur et un jour donnés,
// toujours le même triplet de quêtes, dès le premier calcul — pas besoin
// d'avoir déjà écrit en base pour le prédire.
const pickTemplatesFor = (userId: number, day: number): QuestTemplate[] => {
	const seed = userId + day;
	const picked: QuestTemplate[] = [];
	for (let slot = 0; slot < QUESTS_PER_DAY; slot++) {
		picked.push(QUEST_TEMPLATES[(seed + slot) % QUEST_TEMPLATES.length]);
	}
	return picked;
};

// Assigne les 3 quêtes du jour au premier appel de la journée pour ce joueur
// (paresseux, même pattern que rankedModel.getStats/solo_stats.getStats),
// puis les renvoie — idempotent, un second appel le même jour ne change rien.
const ensureTodayQuests = async (userId: number): Promise<DailyQuestRow[]> => {
	const templates = pickTemplatesFor(userId, dayNumber());
	for (let slot = 0; slot < templates.length; slot++) {
		const template = templates[slot];
		await db.query(
			`INSERT INTO daily_quests (user_id, quest_date, slot, quest_code, progress, target, reward_currency)
			 VALUES (?, CURDATE(), ?, ?, 0, ?, ?)
			 ON DUPLICATE KEY UPDATE user_id = user_id`,
			[userId, slot, template.code, template.target, template.rewardCurrency],
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
			claimed: quest.claimed_at !== null,
		})),
		resets_at: resetsAt.toISOString(),
	};
};

interface MatchRaceData {
	// Nombre de cartes jouées pendant le match, par race — alimente les
	// quêtes play_race quel que soit le résultat du match.
	cardsPlayedByRace?: Record<string, number>;
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
	mode: "solo" | "ranked",
	won: boolean,
	raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureTodayQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "play" || (template.objective === "win" && won)) {
			await db.query("UPDATE daily_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "win_ranked" && won && mode === "ranked") {
			await db.query("UPDATE daily_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_race" && template.race) {
			const count = raceData.cardsPlayedByRace?.[template.race] ?? 0;
			if (count <= 0) continue;
			await db.query("UPDATE daily_quests SET progress = LEAST(progress + ?, target) WHERE id = ?", [count, quest.id]);
		} else if (template.objective === "win_race" && template.race && won) {
			if (!raceData.deckRaces?.includes(template.race)) continue;
			await db.query("UPDATE daily_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		}
	}
};

// Verrouille la ligne (FOR UPDATE) pour qu'un double-clic/double-appel réseau
// ne puisse jamais créditer deux fois la même quête — même garde-fou que
// currencyModel.debit.
const claimQuest = async (
	userId: number,
	questId: number,
): Promise<{ balance: number; reward_currency: number }> => {
	const connection = await db.getConnection();
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

		await connection.query("UPDATE daily_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		await credit(userId, quest.reward_currency, "daily_quest_claim", String(questId), connection);

		await connection.commit();
		return { balance: await getBalance(userId), reward_currency: quest.reward_currency };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export {
	QUEST_TEMPLATES,
	QuestNotFoundError,
	QuestNotCompletedError,
	QuestAlreadyClaimedError,
	ensureTodayQuests,
	getDailyQuests,
	progressForMatch,
	claimQuest,
};
