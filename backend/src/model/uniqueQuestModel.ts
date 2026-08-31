import type { RowDataPacket } from "mysql2";
import db from "./db";
import { credit, getBalance, creditFreePacks, getFreePacks } from "./currencyModel";

// Même principe que QUEST_TEMPLATES/WEEKLY_QUEST_TEMPLATES (catalogue en
// code, pas en base), mais ces quêtes ne resettent jamais : une ligne par
// joueur/quest_code, assignée une seule fois (paresseusement, comme les
// autres), toujours renvoyée en entier (pas de rotation par slot) tant
// qu'elle n'a pas été réclamée. Récompenses volontairement plus généreuses
// (objectifs longs, souvent des paliers de carrière).
interface UniqueQuestTemplate {
	code: string;
	objective:
		| "play"
		| "win"
		| "win_ranked"
		| "play_race_first"
		| "win_multirace_first"
		| "win_all_races"
		| "open_packs"
		| "reach_tier";
	target: number;
	rewardCurrency: number;
	rewardPack: number;
	descriptionKey: string;
	// Uniquement pour play_race_first : nom de race tel qu'utilisé côté
	// client (Race.get_race_name).
	race?: string;
	// Uniquement pour reach_tier : seuil de MMR requis, dupliqué depuis
	// RankTier.THRESHOLDS côté client (voir RANK_TIER_MMR_THRESHOLDS
	// ci-dessous) — le backend n'a autrement aucune notion de palier.
	tier?: "gold" | "legend";
}

const IMPLEMENTED_RACES = ["Human", "Undead", "Demon", "Abomination"] as const;

// Copie de RankTier.THRESHOLDS (scripts/data/RankTier.gd côté client) : à
// tenir synchronisé si les seuils changent là-bas. Uniquement les deux
// paliers concernés par une quête unique.
const RANK_TIER_MMR_THRESHOLDS: Record<"gold" | "legend", number> = {
	gold: 1300,
	legend: 1600,
};

const raceFirstQuestTemplates = (): UniqueQuestTemplate[] =>
	IMPLEMENTED_RACES.map((race) => ({
		code: `first_${race.toLowerCase()}`,
		objective: "play_race_first" as const,
		race,
		target: 1,
		rewardCurrency: 150,
		rewardPack: 0,
		descriptionKey: `QUEST_UNIQUE_FIRST_${race.toUpperCase()}`,
	}));

const UNIQUE_QUEST_TEMPLATES: UniqueQuestTemplate[] = [
	...raceFirstQuestTemplates(),
	{
		code: "first_multirace_win",
		objective: "win_multirace_first",
		target: 1,
		rewardCurrency: 250,
		rewardPack: 0,
		descriptionKey: "QUEST_UNIQUE_FIRST_MULTIRACE",
	},
	{
		code: "win_all_races",
		objective: "win_all_races",
		target: IMPLEMENTED_RACES.length,
		rewardCurrency: 500,
		rewardPack: 1,
		descriptionKey: "QUEST_UNIQUE_WIN_ALL_RACES",
	},
	{ code: "play_50", objective: "play", target: 50, rewardCurrency: 300, rewardPack: 0, descriptionKey: "QUEST_UNIQUE_PLAY_50" },
	{ code: "play_200", objective: "play", target: 200, rewardCurrency: 800, rewardPack: 1, descriptionKey: "QUEST_UNIQUE_PLAY_200" },
	{ code: "win_25", objective: "win", target: 25, rewardCurrency: 400, rewardPack: 0, descriptionKey: "QUEST_UNIQUE_WIN_25" },
	{ code: "win_100", objective: "win", target: 100, rewardCurrency: 1000, rewardPack: 2, descriptionKey: "QUEST_UNIQUE_WIN_100" },
	{
		code: "win_ranked_10",
		objective: "win_ranked",
		target: 10,
		rewardCurrency: 500,
		rewardPack: 0,
		descriptionKey: "QUEST_UNIQUE_WIN_RANKED_10",
	},
	{
		code: "win_ranked_50",
		objective: "win_ranked",
		target: 50,
		rewardCurrency: 1200,
		rewardPack: 2,
		descriptionKey: "QUEST_UNIQUE_WIN_RANKED_50",
	},
	{
		code: "reach_gold",
		objective: "reach_tier",
		tier: "gold",
		target: 1,
		rewardCurrency: 0,
		rewardPack: 1,
		descriptionKey: "QUEST_UNIQUE_REACH_GOLD",
	},
	{
		code: "reach_legend",
		objective: "reach_tier",
		tier: "legend",
		target: 1,
		rewardCurrency: 0,
		rewardPack: 3,
		descriptionKey: "QUEST_UNIQUE_REACH_LEGEND",
	},
	{
		code: "open_packs_20",
		objective: "open_packs",
		target: 20,
		rewardCurrency: 400,
		rewardPack: 0,
		descriptionKey: "QUEST_UNIQUE_OPEN_PACKS_20",
	},
];

interface UniqueQuestRow extends RowDataPacket {
	id: number;
	user_id: number;
	quest_code: string;
	progress: number;
	target: number;
	reward_currency: number;
	reward_pack: number;
	meta: string | null;
	claimed_at: string | null;
}

interface UniqueQuestsResponse {
	quests: {
		id: number;
		description_key: string;
		progress: number;
		target: number;
		reward_currency: number;
		reward_pack: number;
		claimed: boolean;
	}[];
}

class UniqueQuestNotFoundError extends Error {
	constructor() {
		super("Quête introuvable");
		this.name = "UniqueQuestNotFoundError";
	}
}

class UniqueQuestNotCompletedError extends Error {
	constructor() {
		super("Quête pas encore terminée");
		this.name = "UniqueQuestNotCompletedError";
	}
}

class UniqueQuestAlreadyClaimedError extends Error {
	constructor() {
		super("Récompense déjà réclamée");
		this.name = "UniqueQuestAlreadyClaimedError";
	}
}

const templateByCode = (code: string): UniqueQuestTemplate | undefined =>
	UNIQUE_QUEST_TEMPLATES.find((template) => template.code === code);

// Assigne, au premier appel, une ligne par template (jamais de rotation ni
// de reset) puis renvoie toujours l'intégralité du catalogue pour ce joueur
// — même pattern paresseux/idempotent que ensureTodayQuests/
// ensureThisWeekQuests.
const ensureUniqueQuests = async (userId: number): Promise<UniqueQuestRow[]> => {
	for (const template of UNIQUE_QUEST_TEMPLATES) {
		await db.query(
			`INSERT INTO unique_quests (user_id, quest_code, progress, target, reward_currency, reward_pack)
			 VALUES (?, ?, 0, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE user_id = user_id`,
			[userId, template.code, template.target, template.rewardCurrency, template.rewardPack],
		);
	}
	const [rows] = await db.query<UniqueQuestRow[]>(
		"SELECT * FROM unique_quests WHERE user_id = ? ORDER BY id",
		[userId],
	);
	return rows;
};

const getUniqueQuests = async (userId: number): Promise<UniqueQuestsResponse> => {
	const quests = await ensureUniqueQuests(userId);
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
	};
};

interface MatchRaceData {
	// Races présentes dans le deck utilisé pour ce match, tout résultat
	// confondu — alimente play_race_first (peu importe victoire/défaite) et,
	// seulement en cas de victoire, win_multirace_first/win_all_races.
	deckRaces?: string[];
}

// Fait progresser les quêtes uniques actives concernées par ce résultat de
// match — appelé juste à côté de questModel.progressForMatch/
// weeklyQuestModel.progressForMatch, depuis les mêmes controllers.
const progressForMatch = async (
	userId: number,
	mode: "solo" | "ranked",
	won: boolean,
	raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureUniqueQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "play") {
			await db.query("UPDATE unique_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "win" && won) {
			await db.query("UPDATE unique_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "win_ranked" && won && mode === "ranked") {
			await db.query("UPDATE unique_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_race_first" && template.race) {
			if (!raceData.deckRaces?.includes(template.race)) continue;
			await db.query("UPDATE unique_quests SET progress = target WHERE id = ?", [quest.id]);
		} else if (template.objective === "win_multirace_first") {
			if (!won || (raceData.deckRaces?.length ?? 0) < 2) continue;
			await db.query("UPDATE unique_quests SET progress = target WHERE id = ?", [quest.id]);
		} else if (template.objective === "win_all_races") {
			if (!won || !raceData.deckRaces?.length) continue;
			const alreadyWon = quest.meta ? quest.meta.split(",") : [];
			const newRaces = raceData.deckRaces.filter(
				(race) => (IMPLEMENTED_RACES as readonly string[]).includes(race) && !alreadyWon.includes(race),
			);
			if (newRaces.length === 0) continue;
			const merged = [...alreadyWon, ...newRaces];
			await db.query("UPDATE unique_quests SET progress = ?, meta = ? WHERE id = ?", [merged.length, merged.join(","), quest.id]);
		}
	}
};

// Appelé après l'octroi des cartes d'un pack (openPack/openOwnedPack),
// aussi bien payant que gratuit — l'objectif est d'avoir ouvert des packs,
// peu importe la source.
const progressForPackOpen = async (userId: number, count = 1): Promise<void> => {
	const quests = await ensureUniqueQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (template?.objective !== "open_packs") continue;
		await db.query("UPDATE unique_quests SET progress = LEAST(progress + ?, target) WHERE id = ?", [count, quest.id]);
	}
};

// Appelé après toute mise à jour de MMR (confirmMatch) avec le nouveau MMR
// du joueur — le palier est calculé ici, jamais stocké/déclaré par le
// client (voir RANK_TIER_MMR_THRESHOLDS).
const progressForRankTier = async (userId: number, mmr: number): Promise<void> => {
	const quests = await ensureUniqueQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (template?.objective !== "reach_tier" || !template.tier) continue;
		if (mmr < RANK_TIER_MMR_THRESHOLDS[template.tier]) continue;
		await db.query("UPDATE unique_quests SET progress = target WHERE id = ?", [quest.id]);
	}
};

// Verrouille la ligne (FOR UPDATE) — même garde-fou anti-double-clic que
// questModel.claimQuest/weeklyQuestModel.claimWeeklyQuest. Une quête unique
// peut porter une récompense en or, en packs, ou (rarement) les deux.
const claimUniqueQuest = async (
	userId: number,
	questId: number,
): Promise<{ balance: number; free_packs: number; reward_currency: number; reward_pack: number }> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		const [rows] = await connection.query<UniqueQuestRow[]>(
			"SELECT * FROM unique_quests WHERE id = ? AND user_id = ? FOR UPDATE",
			[questId, userId],
		);
		const quest = rows[0];
		if (!quest) throw new UniqueQuestNotFoundError();
		if (quest.claimed_at !== null) throw new UniqueQuestAlreadyClaimedError();
		if (quest.progress < quest.target) throw new UniqueQuestNotCompletedError();

		await connection.query("UPDATE unique_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		if (quest.reward_currency > 0) {
			await credit(userId, quest.reward_currency, "unique_quest_claim", String(questId), connection);
		}
		if (quest.reward_pack > 0) {
			await creditFreePacks(userId, quest.reward_pack, connection);
		}

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
	UNIQUE_QUEST_TEMPLATES,
	UniqueQuestNotFoundError,
	UniqueQuestNotCompletedError,
	UniqueQuestAlreadyClaimedError,
	ensureUniqueQuests,
	getUniqueQuests,
	progressForMatch,
	progressForPackOpen,
	progressForRankTier,
	claimUniqueQuest,
};
