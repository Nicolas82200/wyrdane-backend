import type { RowDataPacket } from "mysql2";
import db from "./db";
import { credit, getBalance, creditFreePacks, getFreePacks, getFreePacksByRace } from "./currencyModel";
import { applyXp } from "./levelModel";
import { countsForMatchQuests, type QuestMatchMode } from "./questMatchMode";

// Même principe que weeklyQuestModel (catalogue en code, reset périodique)
// mais objectifs nettement plus longs et récompense double (or + packs) pour
// marquer le coup une fois par mois — voir "Quêtes mensuelles" dans CLAUDE.md.
//
// Le slot LOGIN_STREAK_SLOT (le dernier) porte LOGIN_STREAK_TEMPLATE, qui ne
// dépend d'aucune partie jouée : contrairement aux autres objectifs
// (alimentés par progressForMatch), celui-ci progresse via progressForLogin,
// appelé à chaque connexion réussie (authController.loginWithSteamId).
interface MonthlyQuestTemplate {
	code: string;
	objective: "play" | "win" | "play_race_all" | "play_multirace" | "open_packs" | "login";
	target: number;
	rewardCurrency: number;
	rewardPack: number;
	rewardXp: number;
	descriptionKey: string;
	// Pack de race offert EN PLUS de rewardPack (multirace) : un nom de race,
	// ou "all" pour un pack de chacune des races implémentées. Voir
	// docs/backend-contracts/race-packs.md côté card-game.
	rewardPackRace?: string;
}

const IMPLEMENTED_RACES = ["Undead", "Human", "Demon", "Abomination"] as const;

// Un pack de CHAQUE race (valeur spéciale de rewardPackRace).
const ALL_RACES_PACK = "all";

// Refonte du 2026-11-02 : plus aucun tirage au sort, les six quêtes du mois
// sont fixes. Les quatre quêtes de race d'avant (une par race, tirées) ont
// fusionné en une seule, play_race_all, qui demande 100 cartes de CHAQUE race
// — un joueur ne subit plus un tirage sur une race qu'il ne joue pas.
const MONTHLY_QUEST_TEMPLATES: MonthlyQuestTemplate[] = [
	{
		code: "play_150",
		objective: "play",
		target: 150,
		rewardCurrency: 750,
		rewardPack: 1,
		rewardXp: 0,
		descriptionKey: "QUEST_MONTHLY_PLAY_150",
	},
	{
		code: "win_75",
		objective: "win",
		target: 75,
		rewardCurrency: 750,
		rewardPack: 1,
		rewardXp: 0,
		descriptionKey: "QUEST_MONTHLY_WIN_75",
	},
	{
		code: "play_multirace_25",
		objective: "play_multirace",
		target: 25,
		// Volontairement sans or : sa récompense est entièrement en packs, un
		// de chaque race plus un multirace.
		rewardCurrency: 0,
		rewardPack: 1,
		rewardXp: 0,
		rewardPackRace: ALL_RACES_PACK,
		descriptionKey: "QUEST_MONTHLY_PLAY_MULTIRACE_25",
	},
	{
		code: "play_race_all_100",
		objective: "play_race_all",
		// 100 cartes de chacune des races implémentées : le compteur affiché
		// est la somme des quatre, chacune plafonnée à 100 (voir
		// progressForMatch) — sans ce plafond par race, 400 cartes d'une
		// seule race suffiraient.
		target: 100 * IMPLEMENTED_RACES.length,
		rewardCurrency: 750,
		rewardPack: 1,
		rewardXp: 0,
		descriptionKey: "QUEST_MONTHLY_PLAY_RACE_ALL_100",
	},
	{
		code: "open_packs_10",
		objective: "open_packs",
		target: 10,
		rewardCurrency: 500,
		rewardPack: 0,
		rewardXp: 0,
		descriptionKey: "QUEST_MONTHLY_OPEN_PACKS_10",
	},
];

// Toujours assignée, et la seule quête mensuelle payée en XP : elle ne dépend
// d'aucune partie jouée, juste d'une connexion quotidienne.
const LOGIN_STREAK_TEMPLATE: MonthlyQuestTemplate = {
	code: "login_streak_30",
	objective: "login",
	target: 30,
	rewardCurrency: 1000,
	rewardPack: 0,
	rewardXp: 500,
	descriptionKey: "QUEST_MONTHLY_LOGIN_STREAK_30",
};

const QUESTS_PER_MONTH = MONTHLY_QUEST_TEMPLATES.length;
// Slot du quest fixe (login), juste après les autres.
const LOGIN_STREAK_SLOT = QUESTS_PER_MONTH;

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
	reward_xp: number;
	reward_pack_race: string | null;
	// Progression par race pour play_race_all, chaque entrée plafonnée à 100
	// (voir progressForMatch). MySQL renvoie une colonne JSON déjà désérialisée.
	meta: Record<string, number> | null;
	last_progress_date: string | null;
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
		reward_xp: number;
		reward_pack_race: string | null;
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
	code === LOGIN_STREAK_TEMPLATE.code
		? LOGIN_STREAK_TEMPLATE
		: MONTHLY_QUEST_TEMPLATES.find((template) => template.code === code);

// month_start calculé côté SQL (1er du mois courant) pour rester cohérent
// quel que soit le fuseau du serveur — jamais une date calculée côté JS.
const MONTH_START_SQL = "DATE(DATE_FORMAT(CURDATE(), '%Y-%m-01'))";

const INSERT_MONTHLY_QUEST_SQL = `INSERT INTO monthly_quests
	   (user_id, month_start, slot, quest_code, progress, target, reward_currency, reward_pack, reward_xp, reward_pack_race)
	 VALUES (?, ${MONTH_START_SQL}, ?, ?, 0, ?, ?, ?, ?, ?)
	 ON DUPLICATE KEY UPDATE user_id = user_id`;

const ensureThisMonthQuests = async (userId: number): Promise<MonthlyQuestRow[]> => {
	// Aucun tirage : les mêmes quêtes pour tout le monde, chaque mois, dans
	// l'ordre du catalogue, puis la quête de connexion sur son slot fixe.
	for (const [slot, template] of [...MONTHLY_QUEST_TEMPLATES, LOGIN_STREAK_TEMPLATE].entries()) {
		await db.query(INSERT_MONTHLY_QUEST_SQL, [
			userId,
			slot,
			template.code,
			template.target,
			template.rewardCurrency,
			template.rewardPack,
			template.rewardXp,
			template.rewardPackRace ?? null,
		]);
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
			reward_xp: quest.reward_xp ?? 0,
			reward_pack_race: quest.reward_pack_race ?? null,
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

// Plafond par race de play_race_all : 100 cartes de CHAQUE race, et pas 400
// d'une seule.
const PLAY_RACE_ALL_PER_RACE = 100;

// Avance la progression par race de play_race_all et renvoie la nouvelle
// somme plafonnée (donc le `progress` à écrire). Pure, pour être testable
// sans base.
const advanceRaceAllProgress = (
	meta: Record<string, number> | null,
	cardsPlayedByRace: Record<string, number>,
): { meta: Record<string, number>; progress: number } => {
	const next: Record<string, number> = {};
	for (const race of IMPLEMENTED_RACES) {
		const played = (meta?.[race] ?? 0) + (cardsPlayedByRace[race] ?? 0);
		next[race] = Math.min(played, PLAY_RACE_ALL_PER_RACE);
	}
	const progress = Object.values(next).reduce((sum, count) => sum + count, 0);
	return { meta: next, progress };
};

// Fait progresser les quêtes mensuelles actives concernées par ce résultat
// de match — même point d'entrée que questModel.progressForMatch/
// weeklyQuestModel.progressForMatch (appelé juste à côté, depuis les mêmes
// controllers, aucune nouvelle télémétrie).
const progressForMatch = async (
	userId: number,
	mode: QuestMatchMode,
	won: boolean,
	raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureThisMonthQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "play" || template.objective === "win" || template.objective === "play_multirace") {
			// Ni l'IA ni une invitation d'ami ne comptent (voir questMatchMode).
			if (!countsForMatchQuests(mode)) continue;
			if (template.objective === "win" && !won) continue;
			if (template.objective === "play_multirace" && (raceData.deckRaces?.length ?? 0) < 2) continue;
			await db.query("UPDATE monthly_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_race_all") {
			const played = raceData.cardsPlayedByRace ?? {};
			const { meta, progress } = advanceRaceAllProgress(quest.meta, played);
			if (progress === quest.progress) continue;
			await db.query("UPDATE monthly_quests SET progress = ?, meta = ? WHERE id = ?", [
				progress,
				JSON.stringify(meta),
				quest.id,
			]);
		}
	}
};

// Progression de la quête « ouvrez 10 packs » — appelée après chaque
// ouverture de pack (packModel), jamais depuis un résultat de match.
const progressForPackOpen = async (userId: number, packs = 1): Promise<void> => {
	const quests = await ensureThisMonthQuests(userId);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		if (templateByCode(quest.quest_code)?.objective !== "open_packs") continue;
		await db.query("UPDATE monthly_quests SET progress = LEAST(progress + ?, target) WHERE id = ?", [
			packs,
			quest.id,
		]);
	}
};

// Appelé à chaque connexion réussie (authController.loginWithSteamId, fire-
// and-forget comme recordLogin/ensureAdminFromEnv juste à côté) : fait
// progresser la quête de connexion d'au plus 1 par jour calendaire, quel que
// soit le nombre de lancements du jeu ce jour-là — last_progress_date sert
// de verrou (la condition dans le WHERE rend l'UPDATE naturellement
// idempotent le même jour, pas besoin de transaction).
const progressForLogin = async (userId: number): Promise<void> => {
	const quests = await ensureThisMonthQuests(userId);
	const quest = quests.find((q) => q.quest_code === LOGIN_STREAK_TEMPLATE.code);
	if (!quest || quest.claimed_at !== null || quest.progress >= quest.target) return;
	await db.query(
		`UPDATE monthly_quests
		 SET progress = LEAST(progress + 1, target), last_progress_date = CURDATE()
		 WHERE id = ? AND (last_progress_date IS NULL OR last_progress_date <> CURDATE())`,
		[quest.id],
	);
};

const claimMonthlyQuest = async (
	userId: number,
	questId: number,
): Promise<{
	balance: number;
	free_packs: number;
	reward_currency: number;
	reward_pack: number;
	reward_xp: number;
	free_packs_by_race: Record<string, number>;
}> => {
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

		const rewardXp = quest.reward_xp ?? 0;
		await connection.query("UPDATE monthly_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		if (quest.reward_currency > 0) {
			await credit(userId, quest.reward_currency, "monthly_quest", String(questId), connection);
		}
		if (quest.reward_pack > 0) await creditFreePacks(userId, quest.reward_pack, connection);
		// Packs de race (en plus du multirace ci-dessus) : "all" en crédite un
		// de chaque race implémentée, sinon un seul de la race nommée.
		if (quest.reward_pack_race === ALL_RACES_PACK) {
			for (const race of IMPLEMENTED_RACES) {
				await creditFreePacks(userId, 1, connection, race);
			}
		} else if (quest.reward_pack_race) {
			await creditFreePacks(userId, 1, connection, quest.reward_pack_race);
		}
		// Dans la transaction : un passage de niveau octroie une récompense de
		// palier, qui doit vivre ou mourir avec la réclamation.
		if (rewardXp > 0) await applyXp(userId, rewardXp, connection);

		await connection.commit();
		return {
			balance: await getBalance(userId),
			free_packs: await getFreePacks(userId),
			reward_currency: quest.reward_currency,
			reward_pack: quest.reward_pack,
			reward_xp: rewardXp,
			free_packs_by_race: await getFreePacksByRace(userId),
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
	LOGIN_STREAK_TEMPLATE,
	QUESTS_PER_MONTH,
	MonthlyQuestNotFoundError,
	MonthlyQuestNotCompletedError,
	MonthlyQuestAlreadyClaimedError,
	ensureThisMonthQuests,
	getMonthlyQuests,
	progressForMatch,
	progressForLogin,
	progressForPackOpen,
	advanceRaceAllProgress,
	claimMonthlyQuest,
};
