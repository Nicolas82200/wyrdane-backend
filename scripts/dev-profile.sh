#!/usr/bin/env bash
# Bidouille de profil joueur, UN SEUL compte a la fois (cible = SteamID64).
#
# A lancer SUR LE VPS depuis /var/www/wyrdane-backend, ou en local avec le
# meme docker compose. Deux actions :
#
#   ./scripts/dev-profile.sh <steamid64> show
#   ./scripts/dev-profile.sh <steamid64> gold <montant>   # +/- sur le solde
#   ./scripts/dev-profile.sh <steamid64> reset            # remet le compte a neuf
#
# `reset` remet le compte dans l'etat "premiere connexion" : collection, decks,
# quetes, niveau, or et tous les drapeaux de reclamation uniques repartent a
# zero, donc le bonus de 500 or (first_login_reward) et le lot de cartes de fin
# de tutoriel (tutorial_reward) sont reclamables a nouveau. Ce qui est PARTAGE
# avec d'autres joueurs n'est pas touche : historique de parties, rapports de
# match, amis, messages, achats a argent reel (purchase_ledger) et cosmetiques.
#
# Cote JEU, le tutoriel est marque comme fait dans un fichier LOCAL, pas en
# base : il faut aussi effacer `tutorial_completed` de
#   %APPDATA%\Godot\app_userdata\Wyrdane\display_settings.cfg
# (voir SettingsManager.gd), sinon le tutoriel ne se relancera pas.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a

STEAM_ID="${1:-}"
ACTION="${2:-show}"
AMOUNT="${3:-}"

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }

[[ "$STEAM_ID" =~ ^[0-9]{17}$ ]] || { echo "SteamID64 attendu (17 chiffres), recu : '${STEAM_ID}'" >&2; usage; }
for var in DB_NAME DB_USER DB_PASSWORD; do
	[ -n "${!var:-}" ] || { echo "variable $var absente de .env" >&2; exit 1; }
done

# --default-character-set=utf8mb4 obligatoire : le client mysql du conteneur
# negocie latin1 faute de locale et corrompt les accents en ecriture.
sql() {
	docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
		mysql --default-character-set=utf8mb4 -u "$DB_USER" "$DB_NAME" "$@"
}

USER_ID="$(sql -N -B -e "SELECT user_id FROM linked_accounts WHERE provider='steam' AND external_id='$STEAM_ID';" | tr -d '\r')"
[ -n "$USER_ID" ] || { echo "aucun compte Wyrdane lie au SteamID $STEAM_ID" >&2; exit 1; }

show() {
	sql -t -e "SELECT u.id, u.username, u.soft_currency AS or_, u.free_packs, u.level, u.xp,
	       u.starter_claimed_at IS NOT NULL AS starter,
	       u.first_login_reward_claimed_at IS NOT NULL AS bonus_500,
	       u.tutorial_reward_claimed_at IS NOT NULL AS lot_tuto,
	       (SELECT COALESCE(SUM(quantity),0) FROM user_cards WHERE user_id=u.id) AS cartes,
	       (SELECT COUNT(*) FROM decks WHERE user_id=u.id) AS decks
	  FROM users u WHERE u.id=$USER_ID;"
}

case "$ACTION" in
show)
	show
	;;
gold)
	[[ "$AMOUNT" =~ ^-?[0-9]+$ ]] || { echo "montant entier attendu (ex. 5000 ou -500)" >&2; exit 1; }
	# GREATEST(0, ...) : le solde est INT NOT NULL, un retrait trop grand le
	# rendrait negatif et la boutique ferait des comptes absurdes.
	# Ecriture aussi dans currency_ledger, qui est l'audit de reference.
	sql -e "UPDATE users SET soft_currency = GREATEST(0, soft_currency + ($AMOUNT)) WHERE id=$USER_ID;
	        INSERT INTO currency_ledger (user_id, amount, reason) VALUES ($USER_ID, $AMOUNT, 'dev_grant');"
	show
	;;
reset)
	echo "Compte vise :"; show
	read -r -p "Tout remettre a zero pour CE compte ? tape le SteamID pour confirmer : " confirm
	[ "$confirm" = "$STEAM_ID" ] || { echo "annule." >&2; exit 1; }
	# deck_cards, non liste, part en cascade avec decks.
	sql -e "START TRANSACTION;
	        DELETE FROM user_cards        WHERE user_id=$USER_ID;
	        DELETE FROM decks             WHERE user_id=$USER_ID;
	        DELETE FROM currency_ledger   WHERE user_id=$USER_ID;
	        DELETE FROM login_rewards     WHERE user_id=$USER_ID;
	        DELETE FROM level_rewards     WHERE user_id=$USER_ID;
	        DELETE FROM daily_quests      WHERE user_id=$USER_ID;
	        DELETE FROM weekly_quests     WHERE user_id=$USER_ID;
	        DELETE FROM monthly_quests    WHERE user_id=$USER_ID;
	        DELETE FROM unique_quests     WHERE user_id=$USER_ID;
	        DELETE FROM onboarding_quests WHERE user_id=$USER_ID;
	        DELETE FROM user_pack_stock   WHERE user_id=$USER_ID;
	        DELETE FROM card_play_stats   WHERE user_id=$USER_ID;
	        DELETE FROM solo_stats        WHERE user_id=$USER_ID;
	        DELETE FROM ranked_stats      WHERE user_id=$USER_ID;
	        DELETE FROM matchmaking_tickets WHERE user_id=$USER_ID;
	        DELETE FROM referrals         WHERE referrer_id=$USER_ID OR referred_id=$USER_ID;
	        UPDATE users SET soft_currency=0, free_packs=0, level=1, xp=0,
	               starter_claimed_at=NULL, starter_currency_claimed_at=NULL,
	               tutorial_reward_claimed_at=NULL, first_login_reward_claimed_at=NULL
	         WHERE id=$USER_ID;
	        COMMIT;"
	echo "Fait. Pense a effacer tutorial_completed dans display_settings.cfg cote jeu."
	show
	;;
*)
	usage
	;;
esac
