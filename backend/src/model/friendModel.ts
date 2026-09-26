import type { RowDataPacket, ResultSetHeader } from "mysql2";
import db from "./db";

// Fenêtre de "en ligne" : un joueur est considéré en ligne si son dernier
// heartbeat (voir presenceModel.ts) date de moins de ça. Le client envoie un
// heartbeat toutes les HEARTBEAT_INTERVAL_SECONDS (voir PresenceService.gd),
// cette fenêtre doit rester nettement plus large pour tolérer un ou deux
// battements manqués (latence réseau, requête en attente) sans faire
// clignoter le statut en ligne/hors ligne.
const ONLINE_WINDOW_SECONDS = 90;

interface SearchResultRow extends RowDataPacket {
	id: number;
	username: string;
	steam_id: string | null;
}

interface FriendshipRow extends RowDataPacket {
	id: number;
	requester_id: number;
	addressee_id: number;
	status: "pending" | "accepted";
	created_at: string;
	responded_at: string | null;
}

interface FriendRow extends RowDataPacket {
	friendship_id: number;
	id: number;
	username: string;
	steam_id: string | null;
	presence: "online" | "in_game" | "offline";
}

interface IncomingRequestRow extends RowDataPacket {
	friendship_id: number;
	id: number;
	username: string;
	created_at: string;
}

// Recherche par pseudo (sous-chaîne, insensible à la casse), pour la barre de
// recherche "ajouter un ami" — même pattern que rankedModel.searchLeaderboard.
// steam_id (via linked_accounts) permet au client de croiser le résultat avec
// sa propre liste d'amis Steam (badge Steam vs Wyrdane, voir FriendsPanel.gd)
// sans qu'aucune donnée Steam ne transite jamais par ce serveur.
const searchUsers = async (query: string, excludeUserId: number, limit = 20): Promise<SearchResultRow[]> => {
	const [rows] = await db.query<SearchResultRow[]>(
		`SELECT u.id, u.username, la.external_id AS steam_id
		 FROM users u
		 LEFT JOIN linked_accounts la ON la.user_id = u.id AND la.provider = 'steam'
		 WHERE u.username LIKE ? AND u.id != ?
		 ORDER BY u.username
		 LIMIT ?`,
		[`%${query}%`, excludeUserId, limit],
	);
	return rows;
};

// Cherche une relation existante entre deux joueurs, dans n'importe quel sens
// (A a demandé B, ou B a demandé A) — une seule ligne peut exister entre deux
// joueurs donnés (UNIQUE KEY côté requester_id/addressee_id ne couvre qu'un
// sens, donc cette fonction vérifie explicitement les deux avant tout INSERT).
const findFriendship = async (userAId: number, userBId: number): Promise<FriendshipRow | null> => {
	const [rows] = await db.query<FriendshipRow[]>(
		`SELECT * FROM friendships
		 WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
		[userAId, userBId, userBId, userAId],
	);
	return rows[0] ?? null;
};

type SendRequestResult = "sent" | "already_friends" | "already_pending" | "auto_accepted";

// Envoie une demande d'ami. Si l'autre joueur a déjà une demande pending vers
// NOUS, on l'accepte directement plutôt que de créer une seconde ligne
// symétrique redondante — comportement attendu ("vous étiez déjà en train de
// vous ajouter mutuellement"). Ne fait jamais deux lignes pour la même paire.
const sendFriendRequest = async (requesterId: number, addresseeId: number): Promise<SendRequestResult> => {
	const existing = await findFriendship(requesterId, addresseeId);
	if (existing) {
		if (existing.status === "accepted") return "already_friends";
		if (existing.requester_id === requesterId) return "already_pending";
		// existing.requester_id === addresseeId : l'autre joueur nous avait déjà
		// demandé en ami — accepter directement sa demande plutôt que la nôtre.
		await db.query("UPDATE friendships SET status = 'accepted', responded_at = NOW() WHERE id = ?", [existing.id]);
		return "auto_accepted";
	}
	await db.query(
		"INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')",
		[requesterId, addresseeId],
	);
	return "sent";
};

// Accepte une demande reçue — seul l'addressee (celui qui a reçu la demande)
// peut l'accepter, jamais celui qui l'a envoyée.
const acceptFriendRequest = async (friendshipId: number, userId: number): Promise<boolean> => {
	const [result] = await db.query<ResultSetHeader>(
		"UPDATE friendships SET status = 'accepted', responded_at = NOW() WHERE id = ? AND addressee_id = ? AND status = 'pending'",
		[friendshipId, userId],
	);
	return result.affectedRows > 0;
};

// Sert à la fois à : refuser une demande reçue, annuler une demande envoyée,
// et supprimer un ami existant — dans tous les cas la ligne est simplement
// supprimée (pas de status='declined' persistant, voir schema.sql), et
// n'importe lequel des deux participants peut le faire.
const deleteFriendship = async (friendshipId: number, userId: number): Promise<boolean> => {
	const [result] = await db.query<ResultSetHeader>(
		"DELETE FROM friendships WHERE id = ? AND (requester_id = ? OR addressee_id = ?)",
		[friendshipId, userId, userId],
	);
	return result.affectedRows > 0;
};

// Liste d'amis (relations acceptées), avec le statut de présence de chacun
// déjà résolu côté SQL (voir ONLINE_WINDOW_SECONDS) — le client n'a jamais à
// connaître users.last_heartbeat_at brut, seulement le statut dérivé.
const getFriends = async (userId: number): Promise<FriendRow[]> => {
	const [rows] = await db.query<FriendRow[]>(
		`SELECT
		   f.id AS friendship_id,
		   u.id, u.username,
		   la.external_id AS steam_id,
		   CASE
		     WHEN u.last_heartbeat_at IS NULL OR u.last_heartbeat_at < NOW() - INTERVAL ? SECOND THEN 'offline'
		     WHEN u.in_game THEN 'in_game'
		     ELSE 'online'
		   END AS presence
		 FROM friendships f
		 JOIN users u ON u.id = IF(f.requester_id = ?, f.addressee_id, f.requester_id)
		 LEFT JOIN linked_accounts la ON la.user_id = u.id AND la.provider = 'steam'
		 WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
		 ORDER BY u.username`,
		[ONLINE_WINDOW_SECONDS, userId, userId, userId],
	);
	return rows;
};

// Demandes reçues en attente (jamais celles envoyées — voir FriendsPanel.gd,
// qui n'affiche que ce qui nécessite une action du joueur local).
const getIncomingRequests = async (userId: number): Promise<IncomingRequestRow[]> => {
	const [rows] = await db.query<IncomingRequestRow[]>(
		`SELECT f.id AS friendship_id, u.id, u.username, f.created_at
		 FROM friendships f
		 JOIN users u ON u.id = f.requester_id
		 WHERE f.addressee_id = ? AND f.status = 'pending'
		 ORDER BY f.created_at DESC`,
		[userId],
	);
	return rows;
};

// Crée (ou accepte) directement une relation "accepted" entre deux joueurs,
// sans passer par l'étape pending — réservé aux amis Steam déjà vérifiés
// (voir resolveSteamIds/autoAddSteamFriends ci-dessous) : la confiance est
// déjà établie par Steam lui-même, redemander une confirmation dans Wyrdane
// serait une friction inutile (voir demande utilisateur du 2026-09-25 :
// "je ne veux pas qu'on ait à les rajouter en jeu"). Idempotent : no-op si
// déjà amis, accepte silencieusement une éventuelle demande pending existante
// plutôt que d'en créer une seconde.
const autoAcceptFriendship = async (userId: number, otherId: number): Promise<void> => {
	const existing = await findFriendship(userId, otherId);
	if (existing) {
		if (existing.status === "accepted") return;
		await db.query("UPDATE friendships SET status = 'accepted', responded_at = NOW() WHERE id = ?", [existing.id]);
		return;
	}
	await db.query(
		"INSERT INTO friendships (requester_id, addressee_id, status, responded_at) VALUES (?, ?, 'accepted', NOW())",
		[userId, otherId],
	);
};

// Borne le nombre de SteamID64 résolus en un seul appel — la liste d'amis
// Steam d'un joueur reste de toute façon plafonnée dans les faits (quelques
// centaines maximum), cette limite protège juste contre un payload construit
// à la main pour énumérer massivement des comptes.
const MAX_STEAM_IDS = 200;

// Résout une liste de SteamID64 (amis Steam locaux du joueur, voir
// SteamService.get_steam_friend_ids côté client) vers les comptes Wyrdane
// correspondants. Résultat consommé par autoAddSteamFriends ci-dessous ;
// exportée séparément pour rester testable indépendamment de l'écriture.
// excludeUserId retire le joueur lui-même du résultat (son propre SteamID64
// peut apparaître dans sa liste d'amis Steam selon l'API, jamais pertinent ici).
const resolveSteamIds = async (steamIds: string[], excludeUserId: number): Promise<SearchResultRow[]> => {
	const bounded = steamIds.slice(0, MAX_STEAM_IDS);
	if (bounded.length === 0) return [];
	const placeholders = bounded.map(() => "?").join(", ");
	const [rows] = await db.query<SearchResultRow[]>(
		`SELECT u.id, u.username, la.external_id AS steam_id
		 FROM users u
		 JOIN linked_accounts la ON la.user_id = u.id AND la.provider = 'steam'
		 WHERE la.external_id IN (${placeholders}) AND u.id != ?`,
		[...bounded, excludeUserId],
	);
	return rows;
};

// Résout les amis Steam locaux vers leurs comptes Wyrdane ET les ajoute
// directement en amis "accepted" (voir autoAcceptFriendship) — appelée à
// chaque ouverture du panneau Amis côté client, idempotente (n'a d'effet que
// sur les nouveaux). Renvoie les comptes traités, pour que l'appelant sache
// combien d'amis Steam ont été synchronisés.
const autoAddSteamFriends = async (steamIds: string[], userId: number): Promise<SearchResultRow[]> => {
	const matches = await resolveSteamIds(steamIds, userId);
	for (const match of matches) {
		await autoAcceptFriendship(userId, match.id);
	}
	return matches;
};

export {
	ONLINE_WINDOW_SECONDS,
	searchUsers,
	resolveSteamIds,
	autoAddSteamFriends,
	findFriendship,
	sendFriendRequest,
	acceptFriendRequest,
	deleteFriendship,
	getFriends,
	getIncomingRequests,
};
export type { SendRequestResult };
