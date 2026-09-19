#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Daily MySQL backup for DeeWaanAI
# ═══════════════════════════════════════════════════════════════════════════════
#
# Usage:
#   DATABASE_URL="mysql://user:pass@host:3306/dbname" ./scripts/backup-db.sh [output-dir]
#
# - Writes a gzipped mysqldump: <output-dir>/swarm-YYYYMMDD-HHMMSS.sql.gz
#   (default output-dir: ./backups)
# - --single-transaction: consistent snapshot without locking tables (InnoDB)
# - Retention: deletes backups older than 7 days
#
# Schedule it from any always-on machine that can reach the database, e.g.
# crontab:  17 3 * * * DATABASE_URL="mysql://..." /path/to/scripts/backup-db.sh /mnt/backups
# (Railway cron job or a small always-on VPS both work; the DB host must be
# reachable — enable the MySQL public TCP endpoint or run inside the network.)
#
# Restore:
#   gunzip -c backups/swarm-<ts>.sql.gz | mysql -h <host> -P <port> -u <user> -p <dbname>
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

url="${DATABASE_URL:?DATABASE_URL is required (mysql://user:pass@host:port/dbname)}"

# Percent-decode URL components (passwords may contain encoded special chars)
urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }

# Parse mysql://user:pass@host:port/dbname
creds="${url#mysql://}"
creds="${creds%%@*}"
user="$(urldecode "${creds%%:*}")"
pass="$(urldecode "${creds#*:}")"
hostport="${url#*@}"
hostport="${hostport%%/*}"
host="${hostport%%:*}"
port="${hostport#*:}"
[ "$port" = "$hostport" ] && port=3306
db="${url##*/}"
db="${db%%\?*}"

outdir="${1:-backups}"
mkdir -p "$outdir"

file="$outdir/swarm-$(date -u +%Y%m%d-%H%M%S).sql.gz"

# Credentials via a process-substitution defaults file — never visible in
# `ps` (unlike -p"$pass") and never written to disk.
mysqldump --defaults-extra-file=<(printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$user" "$pass" "$host" "$port") \
  --skip-ssl-verify-server-cert --single-transaction --routines --triggers "$db" | gzip > "$file"

# Retention: keep 7 days
find "$outdir" -name 'swarm-*.sql.gz' -mtime +7 -delete

echo "Backup written: $file ($(du -h "$file" | cut -f1))"
