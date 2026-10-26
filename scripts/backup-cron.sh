#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Daily backup loop — scheduler wrapper around scripts/backup-db.sh
# ═══════════════════════════════════════════════════════════════════════════════
#
# Runs scripts/backup-db.sh IMMEDIATELY on start, then sleeps 24h and repeats
# forever. Designed to be the entrypoint of the swarm-backup service in
# any scheduler (cron, launchd), and works anywhere bash + mysqldump are present.
#
# Usage:
#   DATABASE_URL="mysql://user:pass@host:3306/dbname" ./scripts/backup-cron.sh
#
# Env:
#   DATABASE_URL            (required) mysql://user:pass@host:port/dbname
#   BACKUP_DIR              (optional) dump output dir.   Default: ./backups
#   BACKUP_INTERVAL_SECONDS (optional) seconds between runs. Default: 86400 (24h)
#
# Notes:
# - `set -u` but deliberately NOT `set -e`: one failed backup must not kill
#   the loop — the failure is logged and the next cycle retries.
# - Each run is logged as a timestamped line on stdout (container logs).
# - backup-db.sh itself is strict (`set -euo pipefail`); this wrapper only
#   catches its exit code. Dumps are gzipped, with 7-day retention applied
#   by backup-db.sh on every run.
# ═══════════════════════════════════════════════════════════════════════════════
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTDIR="${BACKUP_DIR:-backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

log() { echo "[backup-cron] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if [ -z "${DATABASE_URL:-}" ]; then
  log "ERROR: DATABASE_URL is not set (expected mysql://user:pass@host:port/dbname) — refusing to start"
  exit 1
fi

if [ ! -f "${SCRIPT_DIR}/backup-db.sh" ]; then
  log "ERROR: ${SCRIPT_DIR}/backup-db.sh not found — mount the repo's scripts/ directory"
  exit 1
fi

log "scheduler started (interval=${INTERVAL}s output=${OUTDIR})"

while true; do
  log "backup run starting"
  bash "${SCRIPT_DIR}/backup-db.sh" "${OUTDIR}"
  rc=$?
  if [ "${rc}" -eq 0 ]; then
    log "backup run OK"
  else
    log "backup run FAILED (exit ${rc}) — loop continues, next attempt in ${INTERVAL}s"
  fi
  sleep "${INTERVAL}"
done
