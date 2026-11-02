// Mode d'une partie terminée, tel qu'il arrive aux quêtes. Partagé par les
// cinq familles (questModel, weeklyQuestModel, monthlyQuestModel,
// uniqueQuestModel, onboardingQuestModel) : chacune reçoit le même mode et
// doit l'interpréter pareil.
//
// - "solo"     : contre l'IA (rewardsController).
// - "friendly" : partie réseau sur invitation d'ami — aucun appariement par la
//                file, donc aucun jeton de session de match côté backend.
// - "normal"   : appariée par la file, MMR caché.
// - "ranked"   : appariée par la file, MMR public.
//
// Avant le 2026-11-02, rankedController passait littéralement "ranked" pour
// toute partie réseau : une victoire en Normal validait donc les quêtes
// annoncées « classées » (win_ranked_*), et rien ne distinguait une partie sur
// invitation d'ami d'une partie appariée.
type QuestMatchMode = "solo" | "friendly" | "normal" | "ranked";

// Les quêtes « jouez / gagnez N parties » ne comptent que le multijoueur
// réellement apparié : ni l'IA, ni une invitation d'ami (décision produit
// 2026-11-02 — un ami complice rendrait les victoires gratuites).
const countsForMatchQuests = (mode: QuestMatchMode): boolean => mode === "normal" || mode === "ranked";

// Les quêtes explicitement « classées » n'acceptent que le classé.
const isRankedMatch = (mode: QuestMatchMode): boolean => mode === "ranked";

export type { QuestMatchMode };
export { countsForMatchQuests, isRankedMatch };
