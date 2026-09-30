#!/bin/sh
# The REST secret lives in the data volume so it survives image rebuilds and
# container recreation: /data/.hmac, generated once, mode 600. It is exported
# as AGENTMEMORY_SECRET and wins over any value in the environment, the same
# contract the iii-era hub image kept, so clients' existing secret keeps
# working. The value is never printed; read it from the file.
set -eu

HMAC_FILE="${AGENTMEMORY_HMAC_FILE:-/data/.hmac}"

if [ ! -s "$HMAC_FILE" ]; then
  umask 077
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\n")' > "$HMAC_FILE"
  echo "agentmemory: generated a REST secret at $HMAC_FILE"
fi

AGENTMEMORY_SECRET="$(tr -d '\r\n' < "$HMAC_FILE")"
export AGENTMEMORY_SECRET

exec "$@"
