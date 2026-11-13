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
		# thread_name est OBLIGATOIRE : le salon derriere ce webhook est un salon
		# de FORUM, et Discord refuse alors tout post qui n'en fournit pas, avec
		# un 400 et le code 220001 ("Webhooks posted to forum channels must have
		# a thread_name or thread_id"). Constate le 2026-11-12 : l'alerte etait
		# donc silencieusement perdue depuis toujours, exactement au moment ou
		# elle compte, et une sauvegarde en echec ne prevenait personne. Le
		# helper TypeScript (src/helper/discordHelper.ts) gere deja ce cas pour
		# les rapports de plantage ; ce script bash etait le seul oublie.
		# Toujours sur a fournir : un salon textuel classique ignore le champ.
		payload="{\"thread_name\":\"Sauvegarde BDD en echec\",\"content\":\":rotating_light: **Sauvegarde BDD Wyrdane en echec** - $safe\"}"
		curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
			-d "$payload" \
			"$DISCORD_CRASH_WEBHOOK_URL" >/dev/null || true
	fi
	ping_healthcheck fail
}

# « Dead man's switch » : l'alerte Discord ci-dessus ne part que si ce script
# TOURNE et echoue. Si le VPS est mort (panne, attaque, disque plein), rien ne
# tourne, donc rien n'alerte : le silence devient indiscernable de « tout va
# bien ». Pire, un attaquant qui efface la machine efface aussi le mecanisme
# qui aurait pu prevenir. Un surveillant installe ICI mourrait avec la machine :
# il doit etre a l'exterieur.
#
# D'ou ce ping SORTANT vers un service tiers (healthchecks.io ou equivalent),
# qui raisonne a l'envers : c'est l'ABSENCE de ping avant une echeance qui
# declenche son alerte. Un seul mecanisme couvre donc les deux pannes :
# sauvegarde cassee en silence, ET machine disparue.
#
# Conventions du service : l'URL nue = succes, /fail = echec signale tout de
# suite (plutot que d'attendre l'echeance), /start = debut d'execution.
# No-op silencieux si HEALTHCHECK_URL n'est pas renseignee dans .env, meme
# contrat que DISCORD_CRASH_WEBHOOK_URL. Jamais fatal : un service de
# surveillance injoignable ne doit pas faire echouer une sauvegarde valide.
ping_healthcheck() {
	[ -n "${HEALTHCHECK_URL:-}" ] || return 0
	local suffix="${1:-}"
	curl -fsS -m 10 --retry 2 -o /dev/null \
		"${HEALTHCHECK_URL%/}${suffix:+/$suffix}" || true
}

trap 'notify_failure "erreur inattendue ligne $LINENO (voir les logs cron)"' ERR

ping_healthcheck start

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
#
# --no-tablespaces : sans lui, mysqldump 8 tente de lire les metadonnees de
# tablespaces, ce qui exige le privilege PROCESS que le compte applicatif n'a
# pas (et n'a aucune raison d'avoir). Le dump restait valide — ce sont des
# metadonnees, pas des donnees — mais l'erreur s'imprimait dans le log du cron
# CHAQUE NUIT. Un log qui crie en permanence est un log qu'on cesse de lire, et
# c'est la qu'une vraie erreur se noierait. Constate le 2026-11-13 sur la
# premiere execution automatique reelle.
if ! docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
	mysqldump --single-transaction --quick --routines --events --no-tablespaces \
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

# Copie hors du VPS. Deux facons de l'obtenir, et le choix a des consequences :
#
#   - POUSSER d'ici (renseigner BACKUP_REMOTE, destination rsync/ssh) : la copie
#     est garantie a chaque nuit, mais toute destination intermittente — un PC
#     de bureau, typiquement — fait echouer la copie et declenche une alerte
#     Discord CHAQUE nuit ou la machine est eteinte. On finit par ignorer ces
#     alertes, et le jour ou c'en est une vraie on la rate. A reserver a une
#     destination joignable en permanence (espace de stockage dedie).
#   - TIRER depuis l'autre machine (laisser BACKUP_REMOTE vide) : le VPS ne
#     tente rien, donc n'alerte sur rien. La copie n'est fraiche que quand la
#     machine distante tourne — compromis assume, retenu le 2026-11-12 pour la
#     beta (voir docs/beta-launch-runbook.md cote card-game).
#
# Non fatal dans les deux cas : mieux vaut une sauvegarde locale seule
# qu'aucune, mais on alerte.
if [ -n "${BACKUP_REMOTE:-}" ]; then
	rsync -az --timeout=120 "$TARGET" "$BACKUP_REMOTE/" \
		|| notify_failure "copie hors site vers $BACKUP_REMOTE impossible (le dump local, lui, est bien ecrit)"
fi

# Succes : c'est CE ping qui, par son absence, declencherait l'alerte externe.
ping_healthcheck

# Horodatage de la derniere sauvegarde reussie, relu par GET /api/health (donc
# par la commande /status du bot Discord). La base plutot qu'un fichier : ce
# script tourne sur l'hote, l'API dans un conteneur, et aucun volume n'est
# partage entre les deux. Non fatal : la sauvegarde est faite, ce n'est que son
# enregistrement qui echouerait.
SIZE_H="$(du -h "$TARGET" | cut -f1)"
docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
	mysql -u "$DB_USER" "$DB_NAME" -e \
	"INSERT INTO system_status (\`key\`, value) VALUES ('last_backup_at', UTC_TIMESTAMP())
	 ON DUPLICATE KEY UPDATE value = UTC_TIMESTAMP();" 2>/dev/null \
	|| echo "[backup-db] note : horodatage non enregistre en base (sauvegarde faite malgre tout)" >&2

# Confirmation Discord du succes. Volontairement limitee au dump HEBDOMADAIRE
# (dimanche) : un message quotidien qui dit toujours « OK » devient du bruit
# qu'on cesse de lire en une semaine, et c'est precisement ce qui fait rater la
# fois ou il manque. Un rendez-vous hebdomadaire reste lisible, et l'alerte
# d'echec, elle, part toujours immediatement.
# Mettre BACKUP_NOTIFY_ALWAYS=1 dans .env pour recevoir aussi les quotidiennes.
if [ -n "${DISCORD_CRASH_WEBHOOK_URL:-}" ] && { [ "$KIND" = "weekly" ] || [ "${BACKUP_NOTIFY_ALWAYS:-0}" = "1" ]; }; then
	n_daily=$(find "$BACKUP_DIR/daily" -name 'wyrdane_*.sql.gz' -type f 2>/dev/null | wc -l)
	n_weekly=$(find "$BACKUP_DIR/weekly" -name 'wyrdane_*.sql.gz' -type f 2>/dev/null | wc -l)
	ok_payload="{\"thread_name\":\"Sauvegarde BDD\",\"content\":\":white_check_mark: Sauvegarde Wyrdane OK - ${SIZE_H}, ${n_daily} quotidiennes et ${n_weekly} hebdomadaires conservees\"}"
	curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
		-d "$ok_payload" "$DISCORD_CRASH_WEBHOOK_URL" >/dev/null || true
fi

trap - ERR
echo "[backup-db] OK : $TARGET ($SIZE_H)"
