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
	local message="$1"
	echo "[backup-db] ÉCHEC : $message" >&2
	if [ -n "${DISCORD_CRASH_WEBHOOK_URL:-}" ]; then
		# jq n'est pas garanti présent sur le VPS : on échappe à la main le
		# strict nécessaire (guillemets, retours ligne) pour un JSON valide.
		local escaped
		escaped="$(printf '%s' "$message" | sed 's/\/\\/g; s/"/\\"/g' | tr '\n' ' ')"
		curl -fsS -m 15 -X POST -H "Content-Type: application/json" \
			-d "{\"content\":\":rotating_light: **Sauvegarde BDD Wyrdane en échec** — $escaped\"}" \
			"$DISCORD_CRASH_WEBHOOK_URL" >/dev/null || true
	fi
}
trap 'notify_failure "erreur inattendue ligne $LINENO (voir les logs cron)"' ERR

for var in DB_NAME DB_USER DB_PASSWORD; do
	[ -n "${!var:-}" ] || { notify_failure "variable $var absente de .env"; exit 1; }
done

mkdir -p "$TARGET_DIR"

# MYSQL_PWD (passé au conteneur via -e) plutôt que -p en ligne de commande :
# le mot de passe n'apparaît alors pas dans la liste des processus.
if ! docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
	mysqldump --single-transaction --quick --routines --events \
		--default-character-set=utf8mb4 \
		-u "$DB_USER" "$DB_NAME" | gzip -9 > "$TARGET.part"; then
	rm -f "$TARGET.part"
	notify_failure "mysqldump a échoué (conteneur mysql arrêté ? identifiants invalides ?)"
	exit 1
fi

# mysqldump écrit ce marqueur en toute dernière ligne : le retrouver prouve que
# le dump est allé jusqu'au bout et que le gzip est lisible de bout en bout.
if ! gzip -dc "$TARGET.part" | tail -5 | grep -q "Dump completed"; then
	rm -f "$TARGET.part"
	notify_failure "dump tronqué ou illisible (marqueur de fin absent) — sauvegarde précédente conservée"
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
		|| notify_failure "copie hors site vers $BACKUP_REMOTE impossible (le dump local, lui, est bien écrit)"
fi

trap - ERR
echo "[backup-db] OK : $TARGET ($(du -h "$TARGET" | cut -f1))"
