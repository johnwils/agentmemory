#!/usr/bin/env bash
# MCP entry for every client on the Mac (Claude Code plugin, Codex, Cursor, Grok).
# Installed at ~/.agentmemory/mcp-launch.sh. Runs the standalone MCP proxy from the
# global install of this repository (see docs/hub.md, "Clients") against the hub.
set -euo pipefail

env_file="${HOME}/.agentmemory/.env"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

if [[ -z "${AGENTMEMORY_URL:-}" ]]; then
  echo "agentmemory mcp-launch: AGENTMEMORY_URL is unset. Add it to ${env_file}" >&2
  exit 1
fi

# The hub is the only store; never fall back to a local standalone.json.
export AGENTMEMORY_FORCE_PROXY="${AGENTMEMORY_FORCE_PROXY:-1}"
export AGENTMEMORY_TOOLS="${AGENTMEMORY_TOOLS:-all}"

# fnm's default alias follows `fnm default`; the global install lives under that Node.
node_home="${AGENTMEMORY_NODE_HOME:-${HOME}/.local/share/fnm/aliases/default}"
exec "${node_home}/bin/node" \
  "${node_home}/lib/node_modules/@agentmemory/agentmemory/dist/standalone.mjs" "$@"
