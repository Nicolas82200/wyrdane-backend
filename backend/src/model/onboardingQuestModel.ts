import type { RowDataPacket } from "mysql2";
import db from "./db";
import { credit, getBalance, creditFreePacks, getFreePacks } from "./currencyModel";

// Piste de progression réservée aux nouveaux joueurs (niveau de compte 1 à
// 25) : même principe que unique_quests (catalogue en code, une ligne par
// joueur/quest_code, jamais reset), mais la piste entière disparaît de
// GET /api/quests/onboarding dès que le niveau du joueur dépasse 25 — SAUF
// les quêtes déjà validées (progress >= target) au moment où le niveau a été
// dépassé, qui restent réclamables indéfiniment (décision produit : ne pas
// pénaliser un joueur qui n'a juste pas ouvert le menu à temps).
interface OnboardingQuestTemplate {
	code: string;
	objective: "reach_level" | "buy_packs" | "win" | "win_ranked" | "play_network";
	target: number;
	rewardCurrency: number;
	rewardPack: number;
	descriptionKey: string;
	// Uniquement pour reach_level : niveau de compte requis.
	level?: number;
}

const ONBOARDING_QUEST_TEMPLATES: OnboardingQuestTemplate[] = [
	{ code: "reach_level_5", objective: "reach_level", level: 5, target: 1, rewardCurrency: 100, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_REACH_LEVEL_5" },
	{ code: "reach_level_10", objective: "reach_level", level: 10, target: 1, rewardCurrency: 150, rewardPack: 1, descriptionKey: "QUEST_ONBOARDING_REACH_LEVEL_10" },
	{ code: "reach_level_15", objective: "reach_level", level: 15, target: 1, rewardCurrency: 200, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_REACH_LEVEL_15" },
	{ code: "reach_level_20", objective: "reach_level", level: 20, target: 1, rewardCurrency: 250, rewardPack: 1, descriptionKey: "QUEST_ONBOARDING_REACH_LEVEL_20" },
	{ code: "reach_level_25", objective: "reach_level", level: 25, target: 1, rewardCurrency: 400, rewardPack: 2, descriptionKey: "QUEST_ONBOARDING_REACH_LEVEL_25" },
	{ code: "buy_packs_1", objective: "buy_packs", target: 1, rewardCurrency: 50, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_BUY_PACKS_1" },
	{ code: "buy_packs_5", objective: "buy_packs", target: 5, rewardCurrency: 200, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_BUY_PACKS_5" },
	{ code: "buy_packs_10", objective: "buy_packs", target: 10, rewardCurrency: 400, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_BUY_PACKS_10" },
	{ code: "win_5", objective: "win", target: 5, rewardCurrency: 150, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_WIN_5" },
	{ code: "win_ranked_1", objective: "win_ranked", target: 1, rewardCurrency: 100, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_WIN_RANKED_1" },
	{ code: "play_network_1", objective: "play_network", target: 1, rewardCurrency: 50, rewardPack: 0, descriptionKey: "QUEST_ONBOARDING_PLAY_NETWORK_1" },
];

const ONBOARDING_LEVEL_CAP = 25;

interface OnboardingQuestRow extends RowDataPacket {
	id: number;
	user_id: number;
	quest_code: string;
	progress: number;
	target: number;
	reward_currency: number;
	reward_pack: number;
	claimed_at: string | null;
}

interface OnboardingQuestsResponse {
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

class OnboardingQuestNotFoundError extends Error {
	constructor() {
		super("Quête introuvable");
		this.name = "OnboardingQuestNotFoundError";
	}
}

class OnboardingQuestNotCompletedError extends Error {
	constructor() {
		super("Quête pas encore terminée");
		this.name = "OnboardingQuestNotCompletedError";
	}
}

class OnboardingQuestAlreadyClaimedError extends Error {
	constructor() {
		super("Récompense déjà réclamée");
		this.name = "OnboardingQuestAlreadyClaimedError";
	}
}

const templateByCode = (code: string): OnboardingQuestTemplate | undefined =>
	ONBOARDING_QUEST_TEMPLATES.find((template) => template.code === code);

// Assigne, au premier appel, une ligne par template — jamais de rotation ni
// de reset, comme unique_quests. Les quêtes reach_level sont directement
// backfillées sur le niveau actuel du joueur (`currentLevel`) : un joueur
// déjà niveau 12 au moment où cette piste est déployée reçoit d'emblée les
// paliers 5 et 10 comme acquis, plutôt que de ne jamais pouvoir les valider
// (le hook de progression normal ne se déclenche que sur un futur passage de
// niveau, pas rétroactivement).
const ensureOnboardingQuests = async (userId: number, currentLevel: number): Promise<OnboardingQuestRow[]> => {
	const values = ONBOARDING_QUEST_TEMPLATES.map((template) => {
		const progress =
			template.objective === "reach_level" && currentLevel >= (template.level ?? Infinity) ? template.target : 0;
		return [userId, template.code, progress, template.target, template.rewardCurrency, template.rewardPack];
	});
	await db.query(
		`INSERT INTO onboarding_quests (user_id, quest_code, progress, target, reward_currency, reward_pack)
		 VALUES ?
		 ON DUPLICATE KEY UPDATE user_id = user_id`,
		[values],
	);
	const [rows] = await db.query<OnboardingQuestRow[]>(
		"SELECT * FROM onboarding_quests WHERE user_id = ? ORDER BY id",
		[userId],
	);
	return rows;
};

// GET : sous le niveau 25, tout le catalogue (complété ou pas) ; au-delà,
// uniquement les quêtes déjà validées (progress >= target) — voir le
// commentaire en tête de fichier pour la justification produit.
const getOnboardingQuests = async (userId: number, currentLevel: number): Promise<OnboardingQuestsResponse> => {
	const quests = await ensureOnboardingQuests(userId, currentLevel);
	const visible =
		currentLevel > ONBOARDING_LEVEL_CAP ? quests.filter((quest) => quest.progress >= quest.target) : quests;
	return {
		quests: visible.map((quest) => ({
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
	deckRaces?: string[];
}

// Fait progresser win/win_ranked/play_network — appelé juste à côté de
// questModel.progressForMatch/weeklyQuestModel.progressForMatch/
// uniqueQuestModel.progressForMatch, depuis les mêmes controllers
// (rewardsController.reportSoloMatch, rankedController.reportMatch).
// `mode` distingue solo/ranked comme pour les autres pistes ; "ranked" y
// couvre tout match réseau confirmé (classé ou partie rapide), pas
// uniquement le classé — voir progressForMatch de questModel pour le même
// choix.
const progressForMatch = async (
	userId: number,
	currentLevel: number,
	mode: "solo" | "ranked",
	won: boolean,
	_raceData: MatchRaceData = {},
): Promise<void> => {
	const quests = await ensureOnboardingQuests(userId, currentLevel);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (!template) continue;

		if (template.objective === "win" && won) {
			await db.query("UPDATE onboarding_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "win_ranked" && won && mode === "ranked") {
			await db.query("UPDATE onboarding_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		} else if (template.objective === "play_network" && mode === "ranked") {
			await db.query("UPDATE onboarding_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
		}
	}
};

// Appelé depuis packModel.openPack, uniquement sur un achat réel (free ===
// false) — contrairement à uniqueQuestModel.progressForPackOpen qui compte
// aussi les packs gratuits, "acheter" ici doit refléter une vraie dépense
// d'or.
const progressForPackPurchase = async (userId: number, currentLevel: number): Promise<void> => {
	const quests = await ensureOnboardingQuests(userId, currentLevel);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (template?.objective !== "buy_packs") continue;
		await db.query("UPDATE onboarding_quests SET progress = LEAST(progress + 1, target) WHERE id = ?", [quest.id]);
	}
};

// Appelé depuis levelModel.applyXp, une fois par niveau franchi (y compris
// plusieurs fois d'affilée sur un gros gain d'XP) — volontairement hors de
// la transaction XP en cours (même choix que packModel.openPack pour
// progressForPackOpen) : une progression de quête manquée sur erreur ne doit
// jamais faire échouer l'octroi d'XP/de récompense de niveau, qui a déjà
// fait son travail.
const progressForLevel = async (userId: number, level: number): Promise<void> => {
	const quests = await ensureOnboardingQuests(userId, level);
	for (const quest of quests) {
		if (quest.claimed_at !== null || quest.progress >= quest.target) continue;
		const template = templateByCode(quest.quest_code);
		if (template?.objective !== "reach_level" || !template.level) continue;
		if (level < template.level) continue;
		await db.query("UPDATE onboarding_quests SET progress = target WHERE id = ?", [quest.id]);
	}
};

// Verrouille la ligne (FOR UPDATE) — même garde-fou anti-double-clic que
// questModel.claimQuest/uniqueQuestModel.claimUniqueQuest.
const claimOnboardingQuest = async (
	userId: number,
	questId: number,
): Promise<{ balance: number; free_packs: number; reward_currency: number; reward_pack: number }> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();

		const [rows] = await connection.query<OnboardingQuestRow[]>(
			"SELECT * FROM onboarding_quests WHERE id = ? AND user_id = ? FOR UPDATE",
			[questId, userId],
		);
		const quest = rows[0];
		if (!quest) throw new OnboardingQuestNotFoundError();
		if (quest.claimed_at !== null) throw new OnboardingQuestAlreadyClaimedError();
		if (quest.progress < quest.target) throw new OnboardingQuestNotCompletedError();

		await connection.query("UPDATE onboarding_quests SET claimed_at = NOW() WHERE id = ?", [questId]);
		if (quest.reward_currency > 0) {
			await credit(userId, quest.reward_currency, "onboarding_quest_claim", String(questId), connection);
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
	ONBOARDING_QUEST_TEMPLATES,
	ONBOARDING_LEVEL_CAP,
	OnboardingQuestNotFoundError,
	OnboardingQuestNotCompletedError,
	OnboardingQuestAlreadyClaimedError,
	ensureOnboardingQuests,
	getOnboardingQuests,
	progressForMatch,
	progressForPackPurchase,
	progressForLevel,
	claimOnboardingQuest,
};
