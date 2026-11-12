#!/usr/bin/env bash
# Restauration de la base Wyrdane depuis un dump produit par backup-db.sh.
#
#   ./scripts/restore-db.sh /var/backups/wyrdane/daily/wyrdane_2026-09-26_030001.sql.gz
#
# OPÉRATION DESTRUCTIVE : écrase intégralement le contenu actuel de la base.
# Le script exige donc une confirmation tapée à la main, et prend de lui-même
# une sauvegarde de sécurité de l'état courant avant d'écrire quoi que ce soit
# — c'est ce filet qui permet de revenir en arrière si on restaure le mauvais
# dump (l'erreur la plus courante en situation de panique).
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DUMP="${1:-}"
[ -n "$DUMP" ] || { echo "Usage: $0 <chemin/vers/dump.sql.gz>" >&2; exit 1; }
[ -f "$DUMP" ] || { echo "Dump introuvable : $DUMP" >&2; exit 1; }

# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a
for var in DB_NAME DB_USER DB_PASSWORD; do
	[ -n "${!var:-}" ] || { echo "Variable $var absente de .env" >&2; exit 1; }
done

gzip -dc "$DUMP" | tail -5 | grep -q "Dump completed" \
	|| { echo "Ce fichier n'est pas un dump complet (marqueur de fin absent) — restauration refusée." >&2; exit 1; }

echo "Base cible : $DB_NAME (conteneur wyrdane-mysql)"
echo "Dump       : $DUMP ($(du -h "$DUMP" | cut -f1))"
echo
read -r -p "Tape RESTAURER pour écraser la base actuelle : " confirm
[ "$confirm" = "RESTAURER" ] || { echo "Annulé."; exit 1; }

SAFETY="/var/backups/wyrdane/pre-restore_$(date +%Y-%m-%d_%H%M%S).sql.gz"
mkdir -p "$(dirname "$SAFETY")"
echo "Sauvegarde de sécurité de l'état actuel -> $SAFETY"
docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
	mysqldump --single-transaction --quick --routines --events \
	--default-character-set=utf8mb4 -u "$DB_USER" "$DB_NAME" | gzip -9 > "$SAFETY"
chmod 600 "$SAFETY"

echo "Restauration en cours…"
gzip -dc "$DUMP" | docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
	mysql --default-character-set=utf8mb4 -u "$DB_USER" "$DB_NAME"

echo "Redémarrage de l'API pour repartir sur un pool de connexions propre…"
docker compose restart backend

echo "Terminé. État précédent conservé dans $SAFETY (à supprimer une fois la restauration validée)."
