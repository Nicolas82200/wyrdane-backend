import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import db from "./db";

// Export et suppression des données personnelles d'un joueur (RGPD, article 15
// « droit d'accès » et article 17 « droit à l'effacement »). Steam impose de
// traiter ces demandes pour tout jeu distribué sur sa plateforme.
//
// Choix central : la suppression ANONYMISE le compte au lieu de faire un
// `DELETE FROM users` sec. Un DELETE aurait été plus court (toutes les clés
// étrangères cascadent, voir schema.sql) mais faisait deux dégâts collatéraux :
//   - l'historique de parties de l'ADVERSAIRE disparaissait avec (match_history
//     cascade sur player1_id ET player2_id) : effacer ses propres données ne
//     doit pas amputer celles d'un tiers ;
//   - le journal d'achats réels (purchase_ledger) partait aussi, alors qu'une
//     pièce comptable doit être conservée indépendamment du compte.
//
// L'anonymisation retire ce qui identifie la personne — d'abord et surtout le
// SteamID (linked_accounts), seule donnée rattachant une ligne à un être humain
// — et purge tout contenu personnel (messages, amis, decks, collection). Ce qui
// reste (lignes d'historique, écritures comptables) n'est plus rattachable à
// personne : ce ne sont plus des données personnelles au sens du RGPD.
//
// Conséquence voulue : le SteamID étant libéré, se reconnecter avec le même
// compte Steam crée un compte NEUF (voir authController.loginWithSteamId). La
// suppression n'est donc pas un bannissement, et elle est irréversible.

const ANONYMIZED_USERNAME = "Joueur supprimé";

export interface AccountExport {
	exportedAt: string;
	account: RowDataPacket | undefined;
	linkedAccounts: RowDataPacket[];
	collection: RowDataPacket[];
	decks: RowDataPacket[];
	rankedStats: RowDataPacket | undefined;
	soloStats: RowDataPacket | undefined;
	matchHistory: RowDataPacket[];
	currencyLedger: RowDataPacket[];
	purchases: RowDataPacket[];
	quests: {
		daily: RowDataPacket[];
		weekly: RowDataPacket[];
		monthly: RowDataPacket[];
		unique: RowDataPacket[];
	};
	friends: RowDataPacket[];
	messages: RowDataPacket[];
	loginEvents: RowDataPacket[];
}

// Rassemble tout ce que la base contient sur ce joueur, en JSON plutôt qu'en
// dump SQL : c'est ce que le RGPD appelle un format « structuré et couramment
// utilisé ». Les messages incluent ceux reçus, sans lesquels une conversation
// exportée serait incompréhensible — rien de nouveau n'est divulgué au joueur,
// qui voit déjà ces messages et ces pseudos dans le jeu.
const exportUserData = async (userId: number): Promise<AccountExport> => {
	const one = async (sql: string, params: unknown[] = [userId]): Promise<RowDataPacket | undefined> => {
		const [rows] = await db.query<RowDataPacket[]>(sql, params);
		return rows[0];
	};
	const many = async (sql: string, params: unknown[] = [userId]): Promise<RowDataPacket[]> => {
		const [rows] = await db.query<RowDataPacket[]>(sql, params);
		return rows;
	};

	return {
		exportedAt: new Date().toISOString(),
		account: await one(
			`SELECT id, username, soft_currency, free_packs, level, xp, created_at,
			        starter_claimed_at, starter_currency_claimed_at, first_login_reward_claimed_at
			 FROM users WHERE id = ?`,
		),
		linkedAccounts: await many(
			"SELECT provider, external_id, created_at FROM linked_accounts WHERE user_id = ?",
		),
		collection: await many(
			`SELECT c.card_name, uc.quantity
			 FROM user_cards uc JOIN cards c ON c.id = uc.card_id
			 WHERE uc.user_id = ? ORDER BY c.card_name`,
		),
		decks: await many(
			`SELECT d.id AS deck_id, d.name AS deck_name, c.card_name, dc.quantity
			 FROM decks d
			 LEFT JOIN deck_cards dc ON dc.deck_id = d.id
			 LEFT JOIN cards c ON c.id = dc.card_id
			 WHERE d.user_id = ? ORDER BY d.id, c.card_name`,
		),
		rankedStats: await one(
			"SELECT mmr, wins, losses, win_streak, season FROM ranked_stats WHERE user_id = ?",
		),
		soloStats: await one("SELECT wins, losses, win_streak FROM solo_stats WHERE user_id = ?"),
		matchHistory: await many(
			`SELECT id, client_match_id, player1_id, player2_id, winner_id, season,
			        duration_sec, mmr_change_player1, mmr_change_player2,
			        xp_awarded_player1, xp_awarded_player2, played_at
			 FROM match_history
			 WHERE player1_id = ? OR player2_id = ?
			 ORDER BY played_at DESC`,
			[userId, userId],
		),
		currencyLedger: await many(
			`SELECT amount, reason, reference, created_at FROM currency_ledger
			 WHERE user_id = ? ORDER BY created_at DESC`,
		),
		purchases: await many(
			`SELECT item_id, order_id, steam_txn_id, status, created_at FROM purchase_ledger
			 WHERE user_id = ? ORDER BY created_at DESC`,
		),
		quests: {
			daily: await many("SELECT * FROM daily_quests WHERE user_id = ?"),
			weekly: await many("SELECT * FROM weekly_quests WHERE user_id = ?"),
			monthly: await many("SELECT * FROM monthly_quests WHERE user_id = ?"),
			unique: await many("SELECT * FROM unique_quests WHERE user_id = ?"),
		},
		friends: await many(
			`SELECT requester_id, addressee_id, status, created_at, responded_at
			 FROM friendships WHERE requester_id = ? OR addressee_id = ?`,
			[userId, userId],
		),
		messages: await many(
			`SELECT sender_id, recipient_id, body, created_at, read_at FROM messages
			 WHERE sender_id = ? OR recipient_id = ? ORDER BY created_at`,
			[userId, userId],
		),
		loginEvents: await many(
			"SELECT source, created_at FROM login_events WHERE user_id = ? ORDER BY created_at DESC",
		),
	};
};

// Une seule transaction : une suppression à moitié appliquée laisserait un
// compte sans SteamID mais avec ses messages, le pire des deux mondes.
const deleteUserData = async (userId: number): Promise<void> => {
	const connection: PoolConnection = await db.getConnection();
	try {
		await connection.beginTransaction();

		// Le lien vers la personne physique, retiré en premier : c'est lui qui fait
		// de tout le reste une donnée personnelle.
		await connection.query("DELETE FROM linked_accounts WHERE user_id = ?", [userId]);

		// Contenu personnel et social.
		await connection.query("DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?", [userId, userId]);
		await connection.query("DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?", [userId, userId]);
		await connection.query("DELETE FROM game_invites WHERE sender_id = ? OR recipient_id = ?", [userId, userId]);
		await connection.query("DELETE FROM matchmaking_tickets WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?", [userId, userId]);
		await connection.query("DELETE FROM login_events WHERE user_id = ?", [userId]);

		// Progression de jeu : le joueur a demandé l'effacement, on ne garde pas sa
		// collection « au cas où ».
		await connection.query(
			"DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)",
			[userId],
		);
		await connection.query("DELETE FROM decks WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM user_cards WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM user_cosmetics WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM daily_quests WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM weekly_quests WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM monthly_quests WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM unique_quests WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM login_rewards WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM level_rewards WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM solo_stats WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM ranked_stats WHERE user_id = ?", [userId]);
		await connection.query("DELETE FROM match_reports WHERE reporter_id = ?", [userId]);
		// card_play_stats porte un user_id mais sert l'équilibrage agrégé (winrate
		// par carte). La colonne étant NOT NULL, on ne peut pas juste détacher la
		// ligne : on la supprime. L'échantillon perdu est négligeable à l'échelle
		// des statistiques d'équilibrage.
		await connection.query("DELETE FROM card_play_stats WHERE user_id = ?", [userId]);

		// Conservés volontairement, désormais rattachés à un compte anonyme :
		//   - match_history : l'adversaire garde son propre historique intact ;
		//   - purchase_ledger / currency_ledger : traçabilité des achats réels.
		await connection.query(
			`UPDATE users
			 SET username = ?, soft_currency = 0, free_packs = 0, level = 1, xp = 0,
			     is_admin = FALSE, last_heartbeat_at = NULL, in_game = FALSE,
			     deleted_at = CURRENT_TIMESTAMP
			 WHERE id = ?`,
			[ANONYMIZED_USERNAME, userId],
		);

		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};

export { exportUserData, deleteUserData, ANONYMIZED_USERNAME };
