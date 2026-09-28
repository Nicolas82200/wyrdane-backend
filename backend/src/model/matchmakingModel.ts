import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import db from "./db";
import { getStats } from "./rankedModel";
import { toExactLobbyId } from "../helper/steamLobbyId";
import { issueMatchSessionToken } from "../helper/matchSessionToken";

// Fenêtre d'appariement élargie progressivement pour éviter des temps
// d'attente indéfinis avec peu de joueurs simultanés — voir le contrat
// d'origine (docs/backend-contracts/ranked-matchmaking-and-retention.md,
// côté card-game) : ±100 MMR au départ, +50 toutes les 15s, plafond ±500.
const WINDOW_BASE_MMR = 100;
const WINDOW_STEP_MMR = 50;
const WINDOW_STEP_SECONDS = 15;
const WINDOW_MAX_MMR = 500;

// Un ticket sans appariement après ce délai passe en expired. Le client
// abandonne de son côté après 3 min (RANKED_QUEUE_TIMEOUT dans NetLobby.gd) :
// cette valeur n'a donc pas besoin d'être plus courte que ça.
const TICKET_EXPIRY_SECONDS = 300;

// Pondération de l'ancienneté d'un ticket, EXPRIMÉE EN POINTS DE MMR (voir
// pairingScore). À 5/s plafonné à 300, un candidat qui patiente depuis 20s
// « vaut » 100 points d'imprécision de MMR : il passe donc devant un adversaire
// plus proche en MMR mais qui vient d'arriver. Le plafond évite qu'un ticket
// très ancien ne rende le MMR totalement indifférent — et la fenêtre
// (windowFor) reste de toute façon la contrainte dure.
const WAIT_BONUS_MMR_PER_SECOND = 5;
const WAIT_BONUS_MAX_MMR = 300;

// Un ticket n'est appariable que si son propriétaire l'a pollé depuis moins de
// ce délai. Le client poll toutes les 2 s (RANKED_POLL_INTERVAL côté
// MatchmakingOverlay) : 12 s tolèrent plusieurs polls manqués (latence, frame
// bloquée) tout en écartant vite un joueur parti. Indispensable parce qu'un
// ticket ne passe 'expired' que si son PROPRE propriétaire le poll (voir
// getQueueStatus) : un joueur qui ferme le jeu laissait sinon un ticket
// 'waiting' appariable jusqu'à TICKET_EXPIRY_SECONDS, et on l'appariait à un
// fantôme — l'adversaire attendait alors une connexion qui ne viendrait jamais.
const CANDIDATE_LIVENESS_SECONDS = 12;

type QueueMode = "ranked" | "normal";

interface TicketRow extends RowDataPacket {
	id: number;
	ticket_id: string;
	user_id: number;
	mmr: number;
	mode: QueueMode;
	status: "waiting" | "matched" | "cancelled" | "expired";
	opponent_id: number | null;
	role: "host" | "guest" | null;
	steam_lobby_id: string | null;
	match_id: string | null;
	match_session_token: string | null;
	created_at: string;
	last_seen_at: string;
}

// steam_lobby_id est transporté en STRING, jamais en number : un id de lobby
// Steam est un CSteamID 64 bits (ex. 109775243137628014, 57 bits significatifs)
// et un double n'en garde que 53. Sérialisé en nombre JSON, il était arrondi à
// ±8 près (JSON.parse côté Node à l'aller, JSON.parse côté Godot au retour) :
// l'invité rejoignait un lobby voisin inexistant et Steam refusait l'entrée
// avec le code 2 (k_EChatRoomEnterResponseDoesntExist), les deux joueurs
// repartant en boucle de matchmaking. La colonne est un BIGINT et mysql2 le
// renvoie déjà en string : on le laisse tel quel de bout en bout.
type QueueStatusResult =
	| { status: "waiting"; mmr: number; window: number; elapsed_seconds: number }
	| {
			status: "matched";
			role: "host" | "guest";
			opponent_id: number;
			// SteamID64 de l'adversaire, en chaîne de chiffres : c'est l'ADRESSE de
			// rendez-vous depuis le 2026-09-28. L'hôte ouvre un socket d'écoute P2P
			// et n'accepte que cette identité, l'invité s'y connecte directement
			// (ConnectP2P n'exige ni amitié ni lobby commun). Absent si le compte
			// adverse n'a pas de SteamID lié — le client rend alors l'appariement.
			opponent_steam_id?: string;
			// Conservé pour les clients d'une version antérieure, qui attendent
			// encore que l'hôte publie un lobby Steam via POST .../report-lobby.
			// Plus jamais rempli par le client actuel.
			steam_lobby_id?: string;
			match_id: string;
			match_session_token: string;
	  }
	| { status: "cancelled" }
	| { status: "expired" };

const elapsedSeconds = (createdAt: string): number => (Date.now() - new Date(createdAt).getTime()) / 1000;

const windowFor = (elapsed: number): number =>
	Math.min(WINDOW_BASE_MMR + Math.floor(elapsed / WINDOW_STEP_SECONDS) * WINDOW_STEP_MMR, WINDOW_MAX_MMR);

// Départage les candidats DÉJÀ éligibles (dans la fenêtre) en combinant
// proximité de MMR et ancienneté du ticket — le score le plus BAS gagne :
//
//     score = |Δmmr| − BONUS × attente_du_candidat
//
// Sans ce score, findOpponent retenait simplement le premier candidat éligible
// dans l'ordre d'arrivée, donc le ticket le PLUS ANCIEN et jamais le MMR le
// plus proche : avec plusieurs joueurs en file, un adversaire à 90 points
// d'écart passait devant un à 20 points s'il attendait depuis plus longtemps.
// Les deux critères sont désormais combinés (demande utilisateur) : la fenêtre
// garantit qu'on finit toujours par matcher, le score choisit qui parmi les
// éligibles.
const pairingScore = (ticket: TicketRow, candidate: TicketRow): number =>
	Math.abs(candidate.mmr - ticket.mmr) -
	Math.min(elapsedSeconds(candidate.created_at) * WAIT_BONUS_MMR_PER_SECOND, WAIT_BONUS_MAX_MMR);

// Cherche un adversaire compatible parmi les autres tickets en attente DU
// MÊME MODE (jamais un ticket Normal apparié à un ticket Classé — le MMR
// n'a pas le même sens des deux côtés, voir joinQueue), verrouillés FOR
// UPDATE pour qu'un même adversaire ne puisse pas être apparié deux fois par
// deux requêtes concurrentes (join + poll d'un tiers en même temps). La
// fenêtre retenue est la plus large des deux côtés : un joueur qui attend
// depuis longtemps élargit sa propre fenêtre, suffisant pour matcher même si
// l'autre vient d'arriver. Parmi TOUS les candidats éligibles, on retient le
// meilleur au sens de pairingScore (MMR le plus proche, corrigé de
// l'ancienneté) — et non plus le premier venu.
const findOpponent = async (connection: PoolConnection, ticket: TicketRow): Promise<TicketRow | null> => {
	// DEUX bornes temporelles, toutes deux indispensables, et pour des raisons
	// différentes :
	//   - last_seen_at : un ticket ne passe en 'expired' que si SON propre
	//     propriétaire le poll (voir getQueueStatus), donc un joueur qui ferme le
	//     jeu ou perd le réseau laisserait un ticket 'waiting' appariable
	//     indéfiniment. On s'appariait alors à un fantôme, et l'adversaire
	//     attendait une connexion qui ne venait jamais (jusqu'à
	//     HOST_PEER_WAIT_TIMEOUT côté client). Seul un joueur qui poll encore est
	//     candidat.
	//   - created_at : plafond absolu, pour ne jamais apparier un ticket plus
	//     ancien que sa propre durée de vie même si son propriétaire s'acharne à
	//     le poller.
	// Les deux filtres sont faits en SQL avec l'heure du serveur MySQL (même
	// référence que le CURRENT_TIMESTAMP qui écrit ces colonnes), et non avec
	// elapsedSeconds, qui compare Date.now() côté Node à une date écrite en base.
	const [candidates] = await connection.query<TicketRow[]>(
		`SELECT * FROM matchmaking_tickets
		 WHERE status = 'waiting' AND mode = ? AND user_id != ?
		   AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
		   AND last_seen_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
		 ORDER BY created_at ASC FOR UPDATE`,
		[ticket.mode, ticket.user_id, TICKET_EXPIRY_SECONDS, CANDIDATE_LIVENESS_SECONDS],
	);
	const myWindow = windowFor(elapsedSeconds(ticket.created_at));
	let best: TicketRow | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const window = Math.max(myWindow, windowFor(elapsedSeconds(candidate.created_at)));
		// La fenêtre reste une contrainte DURE : un adversaire hors fenêtre n'est
		// jamais rattrapé par son ancienneté.
		if (Math.abs(candidate.mmr - ticket.mmr) > window) continue;
		const score = pairingScore(ticket, candidate);
		// Strictement inférieur : à égalité de score, le candidat le plus ancien
		// gagne, les candidats arrivant triés par created_at ASC.
		if (score < bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
};

// Désigne l'hôte au hasard (50/50) et marque les deux tickets matched en une
// fois — appelé sous transaction avec les deux lignes déjà verrouillées (l'une
// par le SELECT ... FOR UPDATE de l'appelant, l'autre par le FOR UPDATE de
// findOpponent). Autrefois déterministe (le plus petit user_id) : deux
// joueurs qui se retrouvent régulièrement (ex. entre amis) tombaient TOUJOURS
// sur le même hôte, l'autre ne pouvant jamais héberger — corrigé sur demande
// explicite (voir aussi card-game CLAUDE.md, section matchmaking).
// steam_lobby_id est remis à NULL sur les DEUX tickets, et ce n'est PAS
// cosmétique : la table ne garde qu'une ligne par joueur (UNIQUE KEY user_id,
// réutilisée par le ON DUPLICATE KEY UPDATE de joinQueue), donc un ticket
// ré-apparié conservait le lobby du match PRÉCÉDENT — déjà quitté par son
// hôte. toStatusResult le renvoyait dès status='matched', sans vérifier qu'il
// appartient au match courant : l'invité rejoignait un lobby mort et Steam
// refusait l'entrée en code 2 (k_EChatRoomEnterResponseDoesntExist) avant même
// que le nouvel hôte ait créé le sien. Symptôme observé dans les logs : côté
// invité un unique « Adversaire trouvé » immédiatement suivi du joinLobby,
// impossible si l'id venait d'être rapporté par l'hôte.
const pairTickets = async (connection: PoolConnection, ticket: TicketRow, opponent: TicketRow): Promise<void> => {
	const hostId = Math.random() < 0.5 ? ticket.user_id : opponent.user_id;
	// matchId/jeton émis une seule fois ici, à l'appariement réel côté serveur
	// — voir helper/matchSessionToken.ts et TODO.md P9. Les deux tickets
	// reçoivent le même matchId/jeton : chaque joueur le relit à son prochain
	// poll (toStatusResult) et le renvoie tel quel avec POST .../matches/report.
	const matchId = randomUUID();
	const matchSessionToken = issueMatchSessionToken(matchId, ticket.user_id, opponent.user_id);
	await connection.query(
		"UPDATE matchmaking_tickets SET status = 'matched', steam_lobby_id = NULL, opponent_id = ?, role = ?, match_id = ?, match_session_token = ? WHERE id = ?",
		[opponent.user_id, ticket.user_id === hostId ? "host" : "guest", matchId, matchSessionToken, ticket.id],
	);
	await connection.query(
		"UPDATE matchmaking_tickets SET status = 'matched', steam_lobby_id = NULL, opponent_id = ?, role = ?, match_id = ?, match_session_token = ? WHERE id = ?",
		[ticket.user_id, opponent.user_id === hostId ? "host" : "guest", matchId, matchSessionToken, opponent.id],
	);
};

// Remet en file l'ADVERSAIRE d'un appariement que ce joueur est en train
// d'abandonner implicitement (en relançant une recherche). Ne touche jamais
// notre propre ligne : l'appelant l'écrase juste après de toute façon. Ciblé par
// match_id, donc sans effet si l'adversaire a déjà été ré-apparié ailleurs entre
// temps (son match_id aurait changé) — l'appel est idempotent.
const releaseStaleMatch = async (connection: PoolConnection, userId: number): Promise<void> => {
	const [rows] = await connection.query<TicketRow[]>(
		"SELECT * FROM matchmaking_tickets WHERE user_id = ? FOR UPDATE",
		[userId],
	);
	const previous = rows[0];
	if (!previous || previous.status !== "matched" || !previous.match_id) return;
	// last_seen_at n'est VOLONTAIREMENT pas rafraîchi : c'est le signe de vie du
	// joueur, pas un champ de bookkeeping. L'adversaire ne poll plus depuis
	// l'appariement, donc son ticket redevient 'waiting' mais reste inappariable
	// jusqu'à ce qu'il reprenne son polling ou relance une recherche — sans quoi on
	// le réapparierait à l'aveugle, à un moment où son client attend encore une
	// connexion sur l'appariement précédent.
	await connection.query(
		`UPDATE matchmaking_tickets
		 SET status = 'waiting', steam_lobby_id = NULL, opponent_id = NULL, role = NULL,
		     match_id = NULL, match_session_token = NULL, created_at = CURRENT_TIMESTAMP
		 WHERE match_id = ? AND user_id != ?`,
		[previous.match_id, userId],
	);
};

// Rejoint la file : un seul ticket actif par joueur tous modes confondus
// (UNIQUE KEY user_id — un joueur ne peut de toute façon chercher qu'une
// seule partie à la fois), un second appel remplace le précédent plutôt que
// de créer un doublon. Tente immédiatement un appariement plutôt que
// d'attendre le prochain poll, pour matcher tout de suite si un adversaire
// compatible attend déjà.
// mode "ranked" : apparié sur le MMR public affiché (ranked_stats.mmr),
// gagné/perdu uniquement par ce mode (voir rankedModel.confirmMatch).
// mode "normal" : apparié sur un MMR caché (ranked_stats.hidden_mmr), jamais
// affiché ni modifié par le classé — permet de matcher des adversaires de
// niveau similaire en partie Normal sans toucher au classement public
// (comportement demandé façon MMR caché League of Legends).
const joinQueue = async (userId: number, mode: QueueMode): Promise<string> => {
	const stats = await getStats(userId);
	const matchmakingMmr = mode === "normal" ? stats.hidden_mmr : stats.mmr;
	const ticketId = randomUUID();
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		// Une recherche qui remplace un ticket DÉJÀ APPARIÉ doit libérer
		// l'adversaire, et le serveur est le seul endroit où cette garantie tient.
		// La table ne garde qu'une ligne par joueur (UNIQUE KEY user_id, réutilisée
		// par le ON DUPLICATE KEY UPDATE ci-dessous) : en écrasant la nôtre, on
		// perdait le lien vers le match et l'adversaire restait 'matched', donc
		// non ré-appariable (findOpponent ne regarde que les 'waiting'), jusqu'à ce
		// qu'il relance lui-même. Le client appelle bien abandonMatch avant de se
		// remettre en file, mais les deux requêtes HTTP sont indépendantes : si le
		// joinQueue arrive le premier, l'abandon ne trouve plus rien à abandonner
		// (notre ticket n'est plus 'matched') et l'adversaire reste coincé. Le faire
		// ici, dans la même transaction, rend l'ordre d'arrivée indifférent.
		await releaseStaleMatch(connection, userId);
		await connection.query(
			`INSERT INTO matchmaking_tickets (ticket_id, user_id, mmr, mode, status)
			 VALUES (?, ?, ?, ?, 'waiting')
			 ON DUPLICATE KEY UPDATE
			   ticket_id = VALUES(ticket_id), mmr = VALUES(mmr), mode = VALUES(mode), status = 'waiting',
			   opponent_id = NULL, role = NULL, steam_lobby_id = NULL,
			   match_id = NULL, match_session_token = NULL,
			   created_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP`,
			[ticketId, userId, matchmakingMmr, mode],
		);
		const [rows] = await connection.query<TicketRow[]>(
			"SELECT * FROM matchmaking_tickets WHERE user_id = ? FOR UPDATE",
			[userId],
		);
		const ticket = rows[0];
		const opponent = await findOpponent(connection, ticket);
		if (opponent) await pairTickets(connection, ticket, opponent);
		await connection.commit();
		return ticketId;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// opponentSteamId est lu à part (jointure sur linked_accounts, voir
// fetchSteamId) plutôt que stocké sur le ticket : il ne change jamais pour un
// compte donné, le dupliquer dans la table n'apporterait qu'un risque de
// désynchronisation.
const toStatusResult = (ticket: TicketRow, opponentSteamId?: string): QueueStatusResult => {
	if (ticket.status === "matched") {
		return {
			status: "matched",
			role: ticket.role as "host" | "guest",
			opponent_id: ticket.opponent_id as number,
			opponent_steam_id: opponentSteamId,
			steam_lobby_id: toExactLobbyId(ticket.steam_lobby_id),
			match_id: ticket.match_id as string,
			match_session_token: ticket.match_session_token as string,
		};
	}
	if (ticket.status === "cancelled") return { status: "cancelled" };
	if (ticket.status === "expired") return { status: "expired" };
	const elapsed = elapsedSeconds(ticket.created_at);
	return { status: "waiting", mmr: ticket.mmr, window: windowFor(elapsed), elapsed_seconds: Math.floor(elapsed) };
};

// SteamID64 d'un joueur (VARCHAR en base, donc jamais arrondi contrairement à
// un BIGINT lu en nombre — voir helper/steamLobbyId.ts pour l'historique).
// undefined si le compte n'a pas de SteamID lié : c'est possible pour un compte
// créé côté site, et le client doit pouvoir le distinguer d'un id valide plutôt
// que de tenter une connexion P2P vers 0.
const fetchSteamId = async (connection: PoolConnection, userId: number | null): Promise<string | undefined> => {
	if (!userId) return undefined;
	const [rows] = await connection.query<RowDataPacket[]>(
		"SELECT external_id FROM linked_accounts WHERE user_id = ? AND provider = 'steam' LIMIT 1",
		[userId],
	);
	const externalId = rows[0]?.external_id;
	return typeof externalId === "string" && externalId !== "" ? externalId : undefined;
};

// Interroge l'état d'un ticket (poll client toutes les 2s). Retente un
// appariement à chaque appel tant que le ticket est en attente — c'est le
// même mécanisme que joinQueue, pas de job planifié séparé. Un ticket
// introuvable ou appartenant à un autre joueur est traité comme expiré,
// jamais comme une erreur (ticket_id est un UUID non devinable, mais autant
// ne rien exposer côté propriétaire).
const getQueueStatus = async (userId: number, ticketId: string): Promise<QueueStatusResult> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query<TicketRow[]>(
			"SELECT * FROM matchmaking_tickets WHERE ticket_id = ? FOR UPDATE",
			[ticketId],
		);
		const ticket = rows[0];
		if (!ticket || ticket.user_id !== userId) {
			await connection.commit();
			return { status: "expired" };
		}

		if (ticket.status === "waiting" && elapsedSeconds(ticket.created_at) >= TICKET_EXPIRY_SECONDS) {
			await connection.query("UPDATE matchmaking_tickets SET status = 'expired' WHERE id = ?", [ticket.id]);
			await connection.commit();
			return { status: "expired" };
		}

		// Ce poll EST le signe de vie du joueur : sans lui, findOpponent ne saurait
		// pas distinguer un joueur qui attend d'un joueur qui a fermé le jeu (voir
		// CANDIDATE_LIVENESS_SECONDS). Écrit avec l'heure du serveur MySQL, comme
		// la colonne est lue.
		await connection.query("UPDATE matchmaking_tickets SET last_seen_at = NOW() WHERE id = ?", [ticket.id]);

		if (ticket.status === "waiting") {
			const opponent = await findOpponent(connection, ticket);
			if (opponent) {
				await pairTickets(connection, ticket, opponent);
				const [refreshed] = await connection.query<TicketRow[]>(
					"SELECT * FROM matchmaking_tickets WHERE id = ?",
					[ticket.id],
				);
				const steamId = await fetchSteamId(connection, opponent.user_id);
				await connection.commit();
				return toStatusResult(refreshed[0], steamId);
			}
			await connection.commit();
			return toStatusResult(ticket);
		}

		const opponentSteamId = await fetchSteamId(connection, ticket.opponent_id);
		await connection.commit();
		return toStatusResult(ticket, opponentSteamId);
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Hôte uniquement, juste après la création réussie du lobby Steam. Propage le
// steam_lobby_id sur les DEUX tickets (le sien et celui de l'adversaire) en
// une transaction : c'est le ticket de l'invité que celui-ci relit à son
// prochain poll pour rejoindre le lobby (voir getQueueStatus/toStatusResult).
// Renvoie false si l'appelant n'est pas l'hôte confirmé de ce ticket
// (ticket introuvable, pas le sien, pas encore matched, ou role != host).
// steamLobbyId est une chaîne de chiffres (voir QueueStatusResult) : le
// contrôleur la valide avant d'arriver ici, elle part telle quelle en BIGINT.
const reportLobby = async (userId: number, ticketId: string, steamLobbyId: string): Promise<boolean> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query<TicketRow[]>(
			"SELECT * FROM matchmaking_tickets WHERE ticket_id = ? FOR UPDATE",
			[ticketId],
		);
		const ticket = rows[0];
		if (!ticket || ticket.user_id !== userId || ticket.status !== "matched" || ticket.role !== "host" || !ticket.opponent_id) {
			await connection.rollback();
			return false;
		}
		await connection.query("UPDATE matchmaking_tickets SET steam_lobby_id = ? WHERE id = ?", [steamLobbyId, ticket.id]);
		// Le ticket de l'invité n'est mis à jour que s'il est ENCORE sur CE match :
		// sans les gardes status/match_id, un réessai tardif de report-lobby (voir
		// RANKED_REPORT_LOBBY_MAX_ATTEMPTS côté client) écrivait un lobby déjà quitté
		// sur le ticket d'un adversaire entre-temps ré-apparié ailleurs, le condamnant
		// à un code 2 sur son nouveau match.
		await connection.query(
			`UPDATE matchmaking_tickets SET steam_lobby_id = ?
			 WHERE user_id = ? AND opponent_id = ? AND status = 'matched' AND match_id = ?`,
			[steamLobbyId, ticket.opponent_id, ticket.user_id, ticket.match_id],
		);
		await connection.commit();
		return true;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Abandonne un appariement qui n'a pas abouti et remet les DEUX tickets en
// file, en une transaction. C'est le correctif du défaut structurel : jusqu'ici,
// un invité dont l'entrée en lobby échouait se remettait en file TOUT SEUL
// (joinQueue), alors que son hôte restait 'matched' pendant tout son
// HOST_PEER_WAIT_TIMEOUT (60 s). Or findOpponent n'apparie que des tickets
// 'waiting' : les deux joueurs étaient donc structurellement incapables de se
// retrouver pendant une minute, et le client abandonnait bien avant
// (MAX_AUTO_JOIN_RETRIES). En invalidant l'appariement des deux côtés d'un seul
// coup, ils repartent ensemble et se réapparient au poll suivant — avec un
// match_id neuf et un steam_lobby_id vierge (voir pairTickets), donc un lobby
// frais créé par le nouvel hôte.
//
// created_at est réinitialisé volontairement : un ticket qui garderait son
// ancienneté serait aussitôt écarté par la borne d'expiration de findOpponent
// (et marqué 'expired' par getQueueStatus). La contrepartie est que la fenêtre
// de MMR repart à WINDOW_BASE_MMR, ce qui est sans effet entre deux joueurs
// déjà jugés compatibles.
//
// Renvoie false si l'appelant n'est pas le propriétaire d'un ticket réellement
// apparié (rien à abandonner) — le client retombe alors sur un joinQueue normal.
const abandonMatch = async (userId: number, ticketId: string): Promise<boolean> => {
	const connection = await db.getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query<TicketRow[]>(
			"SELECT * FROM matchmaking_tickets WHERE ticket_id = ? FOR UPDATE",
			[ticketId],
		);
		const ticket = rows[0];
		if (!ticket || ticket.user_id !== userId || ticket.status !== "matched" || !ticket.match_id) {
			await connection.rollback();
			return false;
		}
		// Les deux tickets du match, désignés par match_id : on ne touche jamais un
		// ticket que l'adversaire aurait déjà relancé de son côté (son match_id aurait
		// changé), ce qui rend l'appel idempotent et sans effet de bord croisé.
		await connection.query(
			`UPDATE matchmaking_tickets
			 SET status = 'waiting', steam_lobby_id = NULL, opponent_id = NULL, role = NULL,
			     match_id = NULL, match_session_token = NULL, created_at = CURRENT_TIMESTAMP
			 WHERE match_id = ?`,
			[ticket.match_id],
		);
		// Seul l'appelant est encore là, manifestement : lui seul est réputé vivant
		// (voir releaseStaleMatch pour le détail de ce choix).
		await connection.query("UPDATE matchmaking_tickets SET last_seen_at = NOW() WHERE id = ?", [ticket.id]);
		await connection.commit();
		return true;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

// Annule un ticket (bouton Annuler, ou navigation hors de l'écran lobby).
// Idempotent par construction : ne touche qu'un ticket encore 'waiting'
// appartenant à l'appelant, un ticket déjà consommé/expiré/absent ne renvoie
// jamais d'erreur (voir le contrat, DELETE .../:ticket_id doit rester
// silencieux dans tous les cas).
const cancelQueue = async (userId: number, ticketId: string): Promise<void> => {
	await db.query(
		"UPDATE matchmaking_tickets SET status = 'cancelled' WHERE ticket_id = ? AND user_id = ? AND status = 'waiting'",
		[ticketId, userId],
	);
};

export { joinQueue, getQueueStatus, reportLobby, abandonMatch, cancelQueue };
export type { QueueMode };
