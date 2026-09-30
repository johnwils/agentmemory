#!/bin/sh
# Nightly copy of the live store. VACUUM INTO runs inside the daemon's container
# as one read transaction, so it is consistent while the daemon keeps writing.
# The copy is integrity-checked, gzipped next to this script, and the newest
# $KEEP are kept. Restore: stop the stack, gunzip over data/agentmemory.sqlite,
# delete data/agentmemory.sqlite-wal and -shm, start.
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
CONTAINER=${CONTAINER:-agentmemory}
KEEP=${KEEP:-7}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="backup-$STAMP.sqlite"
OUT="$DIR/backups/agentmemory-$STAMP.sqlite.gz"
trap 'rm -f "$DIR/data/$NAME" "$OUT.tmp"' EXIT
mkdir -p "$DIR/backups"
docker exec "$CONTAINER" node -e '
const { DatabaseSync } = require("node:sqlite");
const out = process.argv[1];
new DatabaseSync("/data/agentmemory.sqlite").exec(`VACUUM INTO ${JSON.stringify(out).replace(/"/g, "'\''")}`);
const r = new DatabaseSync(out, { readOnly: true }).prepare("PRAGMA quick_check").get();
if (r.quick_check !== "ok") { console.error("quick_check: " + r.quick_check); process.exit(1); }
' "/data/$NAME"
gzip -c "$DIR/data/$NAME" > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
ls -1t "$DIR"/backups/agentmemory-*.sqlite.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "$(date -u +%FT%TZ) $OUT $(du -h "$OUT" | cut -f1)"
