#!/usr/bin/env bash
# Sauvegarde de la base de production Wyrdane.
#
# À lancer SUR LE VPS depuis le dossier du dépôt (/var/www/wyrdane-backend),
# typiquement par cron (voir « Sauvegardes de la base » dans CLAUDE.md pour la
# ligne crontab et la procédure de restauration).
#
# Ce que le script garantit :
#   - un dump cohérent (--single-transaction : pas de verrou de table sur
#     InnoDB, la prod n'est jamais bloquée pendant la sauvegarde) ;
#   - qu'un dump vide ou tronqué ne remplace JAMAIS une sauvegarde valide
#     (vérification du marqueur de fin que mysqldump écrit en dernier, donc
#     absent si le dump s'est interrompu en cours de route) ;
#   - une rotation bornée (pas de disque plein à terme) ;
#   - une alerte Discord si quoi que ce soit échoue — une sauvegarde qui
#     échoue en silence est exactement aussi utile que pas de sauvegarde.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-/var/backups/wyrdane}"
RETENTION_DAILY="${RETENTION_DAILY:-7}"    # dumps quotidiens conservés
RETENTION_WEEKLY="${RETENTION_WEEKLY:-8}"  # dumps du dimanche conservés (~2 mois)
STAMP="$(date +%Y-%m-%d_%H%M%S)"
# Le dump du dimanche part dans weekly/ : la rotation quotidienne, plus
# agressive, ne peut alors pas emporter tout l'historique ancien.
[ "$(date +%u)" = "7" ] && KIND="weekly" || KIND="daily"
TARGET_DIR="$BACKUP_DIR/$KIND"
TARGET="$TARGET_DIR/wyrdane_${STAMP}.sql.gz"

notify_failure() {
	# Desarme le trap AVANT tout le reste : sans cela, le `exit 1` qui suit chaque
	# appel redeclenche ERR, et une seule panne envoyait trois alertes.
	trap - ERR
	local message="$1"
	echo "[backup-db] ECHEC : $message" >&2
	if [ -n "${DISCORD_CRASH_WEBHOOK_URL:-}" ]; then
		# jq n'est pas garanti present sur le VPS, et echapper du JSON a la main en
		# sed est precisement le genre de detail qui casse en silence (c'est arrive).
		# On retire donc les seuls caracteres qui auraient un effet en JSON
		# (guillemets, antislashs, retours ligne) : les messages de ce script sont
		# ecrits pour rester comprehensibles sans eux.
		local safe
		safe="$(printf '%s' "$message" | tr -d '\\"' | tr '\n' ' ')"
		# Les messages ci-dessus sont en ASCII, mais un chemin ou un nom de variable
		# interpole peut ne pas l'etre : un octet non-ASCII mal transmis par le shell
		# fait refuser la requete par Discord (400 constate en test), et l'alerte se
		# perdrait precisement au moment ou elle compte. iconv vient de la glibc ; si
		# l'appel echoue, on garde le message tel quel plutot que de perdre l'alerte.
		local ascii_safe
		ascii_safe="$(printf '%s' "$safe" | iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null || true)"
		[ -n "$ascii_safe" ] && safe="$ascii_safe"
		local payload
		payload="{\"content\":\":rotating_light: **Sauvegarde BDD Wyrdane en echec** - $safe\"}"
		curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
			-d "$payload" \
			"$DISCORD_CRASH_WEBHOOK_URL" >/dev/null || true
	fi
}
trap 'notify_failure "erreur inattendue ligne $LINENO (voir les logs cron)"' ERR

for var in DB_NAME DB_USER DB_PASSWORD; do
	[ -n "${!var:-}" ] || { notify_failure "variable $var absente de .env"; exit 1; }
done

# Les DEUX sous-dossiers, pas seulement celui du jour : la rotation plus bas
# balaie daily/ ET weekly/, et un `find` sur un dossier inexistant renvoie un
# code non nul — avec `pipefail`, cela déclencherait le trap ERR et une fausse
# alerte Discord le premier dimanche (weekly/ créé, daily/ jamais visité).
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# MYSQL_PWD (passé au conteneur via -e) plutôt que -p en ligne de commande :
# le mot de passe n'apparaît alors pas dans la liste des processus.
if ! docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
	mysqldump --single-transaction --quick --routines --events \
		--default-character-set=utf8mb4 \
		-u "$DB_USER" "$DB_NAME" | gzip -9 > "$TARGET.part"; then
	rm -f "$TARGET.part"
	notify_failure "mysqldump a echoue (conteneur mysql arrete ? identifiants invalides ?)"
	exit 1
fi

# mysqldump écrit ce marqueur en toute dernière ligne : le retrouver prouve que
# le dump est allé jusqu'au bout et que le gzip est lisible de bout en bout.
if ! gzip -dc "$TARGET.part" | tail -5 | grep -q "Dump completed"; then
	rm -f "$TARGET.part"
	notify_failure "dump tronque ou illisible (marqueur de fin absent) - sauvegarde precedente conservee"
	exit 1
fi

mv "$TARGET.part" "$TARGET"
chmod 600 "$TARGET"

# Rotation : on ne supprime qu'APRÈS avoir écrit un dump valide, jamais avant.
find "$BACKUP_DIR/daily" -name 'wyrdane_*.sql.gz' -type f 2>/dev/null \
	| sort -r | tail -n "+$((RETENTION_DAILY + 1))" | xargs -r rm -f
find "$BACKUP_DIR/weekly" -name 'wyrdane_*.sql.gz' -type f 2>/dev/null \
	| sort -r | tail -n "+$((RETENTION_WEEKLY + 1))" | xargs -r rm -f

# Copie hors du VPS : indispensable, une sauvegarde qui vit sur la machine
# qu'elle protège ne couvre pas la perte de cette machine. Renseigner
# BACKUP_REMOTE dans .env (destination rsync/ssh, ex. "user@host:/backups/wyrdane").
# Non fatal : mieux vaut une sauvegarde locale seule qu'aucune, mais on alerte.
if [ -n "${BACKUP_REMOTE:-}" ]; then
	rsync -az --timeout=120 "$TARGET" "$BACKUP_REMOTE/" \
		|| notify_failure "copie hors site vers $BACKUP_REMOTE impossible (le dump local, lui, est bien ecrit)"
fi

trap - ERR
echo "[backup-db] OK : $TARGET ($(du -h "$TARGET" | cut -f1))"
