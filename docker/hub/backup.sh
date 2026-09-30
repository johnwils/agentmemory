#!/bin/sh
# Nightly backup. The daemon's own mem::backup (POST /agentmemory/backup) writes a
# VACUUM INTO snapshot, runs integrity_check and compares row counts with the live
# store, then renames it to data/agentmemory-snapshot.sqlite; it answers 500 on any
# failure. This gzips the snapshot into backups/ and keeps the newest $KEEP.
# Restore: docs/hub.md.
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
KEEP=${KEEP:-7}
SNAP="$DIR/data/agentmemory-snapshot.sqlite"
OUT="$DIR/backups/agentmemory-$(date -u +%Y%m%dT%H%M%SZ).sqlite.gz"
trap 'rm -f "$SNAP" "$OUT.tmp"' EXIT
mkdir -p "$DIR/backups"
# Header on stdin keeps the secret out of the process list.
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$DIR/data/.hmac")" |
  curl -fsS -m 900 -X POST -H @- -H 'Content-Type: application/json' -d '{}' \
    http://127.0.0.1:3111/agentmemory/backup > /dev/null
gzip -c "$SNAP" > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
ls -1t "$DIR"/backups/agentmemory-*.sqlite.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "$(date -u +%FT%TZ) $OUT $(du -h "$OUT" | cut -f1)"
