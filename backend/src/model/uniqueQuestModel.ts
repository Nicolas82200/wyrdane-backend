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
	tier?: RankTierName;
}

const IMPLEMENTED_RACES = ["Human", "Undead", "Demon", "Abomination"] as const;

type RankTierName = "silver" | "gold" | "platinum" | "diamond" | "master" | "legend";

// Copie de RankTier.THRESHOLDS (scripts/data/RankTier.gd côté client) : à
// tenir synchronisé si les seuils changent là-bas. Bronze n'y figure pas —
// c'est le palier de départ de tout le monde, il ne se "gagne" pas.
// Ces valeurs avaient silencieusement divergé du client (gold: 1300 /
// legend: 1600 ici contre 400 / 1200 côté RankTier.gd) : la quête Or ne se
// validait donc qu'à un MMR trois fois supérieur à celui qui affichait déjà
// le badge Or au joueur. Resynchronisé le 2026-09-28.
const RANK_TIER_MMR_THRESHOLDS: Record<RankTierName, number> = {
	silver: 200,
	gold: 400,
	platinum: 600,
	diamond: 800,
	master: 1000,
	legend: 1200,
};

// Récompense par palier de rang : progression régulière jusqu'à Légende
// (1000 or + 5 packs), le plus haut palier atteignable en classé.
const RANK_TIER_REWARDS: Record<RankTierName, { currency: number; pack: number }> = {
	silver: { currency: 100, pack: 1 },
	gold: { currency: 250, pack: 1 },
	platinum: { currency: 400, pack: 2 },
	diamond: { currency: 600, pack: 3 },
	master: { currency: 800, pack: 4 },
	legend: { currency: 1000, pack: 5 },
};

const rankTierQuestTemplates = (): UniqueQuestTemplate[] =>
	(Object.keys(RANK_TIER_MMR_THRESHOLDS) as RankTierName[]).map((tier) => ({
		code: `reach_${tier}`,
		objective: "reach_tier" as const,
		tier,
		target: 1,
		rewardCurrency: RANK_TIER_REWARDS[tier].currency,
		rewardPack: RANK_TIER_REWARDS[tier].pack,
		descriptionKey: `QUEST_UNIQUE_REACH_${tier.toUpperCase()}`,
	}));

// Paliers "jouez X parties" : un tous les 50 jusqu'à 250. Les paliers sont
// indépendants (une ligne chacun), mais partagent le même compteur logique —
// voir syncNewRowsProgress, qui reporte la progression déjà acquise sur un
// palier fraîchement ajouté au catalogue.
const PLAY_MILESTONES: { target: number; currency: number; pack: number }[] = [
	{ target: 50, currency: 500, pack: 0 },
	{ target: 100, currency: 700, pack: 0 },
	{ target: 150, currency: 850, pack: 0 },
	{ target: 200, currency: 1000, pack: 1 },
	{ target: 250, currency: 1200, pack: 2 },
];

const playQuestTemplates = (): UniqueQuestTemplate[] =>
	PLAY_MILESTONES.map(({ target, currency, pack }) => ({
		code: `play_${target}`,
		objective: "play" as const,
		target,
		rewardCurrency: currency,
		rewardPack: pack,
		descriptionKey: `QUEST_UNIQUE_PLAY_${target}`,
	}));

const raceFirstQuestTemplates = (): UniqueQuestTemplate[] =>
	IMPLEMENTED_RACES.map((race) => ({
		code: `first_${race.toLowerCase()}`,
		objective: "play_race_first" as const,
		race,
		target: 1,
		rewardCurrency: 200,
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
	...playQuestTemplates(),
	...rankTierQuestTemplates(),
	{ code: "win_10", objective: "win", target: 10, rewardCurrency: 100, rewardPack: 1, descriptionKey: "QUEST_UNIQUE_WIN_10" },
	{ code: "win_25", objective: "win", target: 25, rewardCurrency: 250, rewardPack: 2, descriptionKey: "QUEST_UNIQUE_WIN_25" },
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
		rewardCurrency: 1000,
		rewardPack: 3,
		descriptionKey: "QUEST_UNIQUE_WIN_RANKED_50",
	},
	{
		code: "open_packs_20",
		objective: "open_packs",
		target: 20,
		rewardCurrency: 0,
		rewardPack: 5,
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
// Un seul INSERT multi-lignes plutôt qu'une requête par template (appelé à
// chaque getUniqueQuests/progression de match/ouverture de pack) : latence
// cumulée évitée sur un endpoint attendu par le joueur en sortie de partie.
const ensureUniqueQuests = async (userId: number): Promise<UniqueQuestRow[]> => {
	const values = UNIQUE_QUEST_TEMPLATES.map((template) => [
		userId,
		template.code,
		0,
		template.target,
		template.rewardCurrency,
		template.rewardPack,
	]);
	await db.query(
		`INSERT INTO unique_quests (user_id, quest_code, progress, target, reward_currency, reward_pack)
		 VALUES ?
		 ON DUPLICATE KEY UPDATE user_id = user_id`,
		[values],
	);
	const [rows] = await db.query<UniqueQuestRow[]>(
		"SELECT * FROM unique_quests WHERE user_id = ? ORDER BY id",
		[userId],
	);
	await reconcileWithTemplates(rows);
	return rows;
};

// Objectifs dont tous les paliers comptent exactement la même chose : leur
// progression est interchangeable d'un palier à l'autre (voir plus bas).
const CUMULATIVE_OBJECTIVES = new Set(["play", "win", "win_ranked", "open_packs"]);

// Recale les lignes déjà assignées sur le catalogue courant, en place (les
// lignes passées en argument sont mises à jour aussi, elles sont renvoyées à
// l'appelant). Deux corrections, toutes deux réservées aux quêtes NON
// réclamées (une récompense déjà versée ne se réécrit jamais a posteriori) :
//
//  1. Cible/récompenses : elles sont figées dans la ligne à l'assignation
//     (l'INSERT ci-dessus n'écrase rien sur doublon), donc sans ce recalage un
//     rééquilibrage du catalogue ne toucherait que les nouveaux comptes.
//  2. Progression d'un palier ajouté après coup (ex. "jouez 250 parties",
//     ouvert le 2026-09-28) : il hérite de la progression déjà acquise sur les
//     paliers voisins du même objectif, sinon un joueur à 300 parties
//     repartirait de zéro dessus.
//
// Aucune requête n'est émise quand tout est déjà conforme (cas courant) : la
// fonction est appelée à chaque getUniqueQuests et à chaque fin de match.
const reconcileWithTemplates = async (rows: UniqueQuestRow[]): Promise<void> => {
	const byCode = new Map(rows.map((row) => [row.quest_code, row]));

	// Meilleure progression connue par objectif cumulatif — une quête réclamée
	// prouve que sa cible a été atteinte, elle compte donc pour sa target.
	const reachedByObjective = new Map<string, number>();
	for (const template of UNIQUE_QUEST_TEMPLATES) {
		if (!CUMULATIVE_OBJECTIVES.has(template.objective)) continue;
		const row = byCode.get(template.code);
		if (!row) continue;
		const reached = row.claimed_at !== null ? row.target : row.progress;
		reachedByObjective.set(template.objective, Math.max(reachedByObjective.get(template.objective) ?? 0, reached));
	}

	for (const template of UNIQUE_QUEST_TEMPLATES) {
		const row = byCode.get(template.code);
		if (!row || row.claimed_at !== null) continue;

		const progress = Math.min(
			Math.max(row.progress, CUMULATIVE_OBJECTIVES.has(template.objective) ? (reachedByObjective.get(template.objective) ?? 0) : 0),
			template.target,
		);
		if (
			row.target === template.target &&
			row.reward_currency === template.rewardCurrency &&
			row.reward_pack === template.rewardPack &&
			row.progress === progress
		) {
			continue;
		}

		await db.query(
			"UPDATE unique_quests SET target = ?, reward_currency = ?, reward_pack = ?, progress = ? WHERE id = ?",
			[template.target, template.rewardCurrency, template.rewardPack, progress, row.id],
		);
		row.target = template.target;
		row.reward_currency = template.rewardCurrency;
		row.reward_pack = template.rewardPack;
		row.progress = progress;
	}
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
	RANK_TIER_MMR_THRESHOLDS,
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
