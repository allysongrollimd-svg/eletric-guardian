#!/usr/bin/env bash
# Takes a fresh snapshot inside the container and copies the snapshots to the host (outside Docker's volume).
#   bash deploy/backup.sh                      -> /var/backups/electric-guardian
# Daily at 03:30:   (crontab -l 2>/dev/null; echo "30 3 * * * bash $PWD/deploy/backup.sh >> /var/log/eg-backup.log 2>&1") | crontab -
# Better still: copy that folder to another machine/cloud (rsync, rclone) — a backup on the same disk does not survive losing the VPS.
set -euo pipefail
cd "$(dirname "$0")"
DEST="${BACKUP_DIR:-/var/backups/electric-guardian}"
KEEP_DAYS="${KEEP_DAYS:-30}"
COMPOSE="docker compose -f docker-compose.nginx.yml"
[ -f docker-compose.nginx.yml ] && [ -n "$($COMPOSE ps -q eg 2>/dev/null)" ] || COMPOSE="docker compose -f docker-compose.yml"
mkdir -p "$DEST"; chmod 700 "$DEST"
SNAP="$($COMPOSE exec -T eg node scripts/backup.mjs 2>/dev/null | tail -1)"
CID="$($COMPOSE ps -q eg)"
docker cp "$CID:$SNAP" "$DEST/"
docker cp "$CID:$(dirname "$SNAP")/session.secret" "$DEST/session.secret" 2>/dev/null || true   # only exists when SESSION_SECRET is not set in .env
[ -f .env ] && cp .env "$DEST/env.backup"                                                       # holds SESSION_SECRET (signs sessions and webhook keys), domains and e-mail
chmod 600 "$DEST"/* 2>/dev/null || true
find "$DEST" -name 'eg-*.sqlite' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $DEST/$(basename "$SNAP")"
