#!/usr/bin/env bash
# Update every Mac client (Claude Code, Grok, Codex, Cursor) to this checkout.
# Does not touch the hub. See docs/hub.md, "Clients".
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
node_home="${AGENTMEMORY_NODE_HOME:-${HOME}/.local/share/fnm/aliases/default}"

if [[ ! -x "${node_home}/bin/node" ]]; then
  echo "update-mac: fnm default Node is missing at ${node_home}/bin/node" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "update-mac: claude is not on PATH" >&2
  exit 1
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "update-mac: codex is not on PATH" >&2
  exit 1
fi

export PATH="${node_home}/bin:${PATH}"
cd "${repo}"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "update-mac: commit or stash local changes first" >&2
  exit 1
fi

git pull --ff-only
npm ci
npm run build

tarball_name="$(npm pack --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(!Array.isArray(j)||!j[0]||!j[0].filename){process.stderr.write("npm pack did not return a filename\n"); process.exit(1)} process.stdout.write(j[0].filename)})')"
tarball_path="${repo}/${tarball_name}"
npm i -g "${tarball_path}"
rm -f "${tarball_path}"

mkdir -p "${HOME}/.agentmemory"
cp "${repo}/clients/mcp-launch.sh" "${HOME}/.agentmemory/mcp-launch.sh"
chmod +x "${HOME}/.agentmemory/mcp-launch.sh"

claude plugin marketplace update agentmemory
claude plugin uninstall agentmemory@agentmemory --scope user
claude plugin install agentmemory@agentmemory --scope user -y

codex_config="${HOME}/.codex/config.toml"
if [[ -f "${codex_config}" ]]; then
  backup="${codex_config}.bak-$(date +%Y%m%d%H%M%S)"
  cp "${codex_config}" "${backup}"
  echo "codex config backup: ${backup}"
fi

marketplace_json="$(codex plugin marketplace list --json)"
if printf '%s' "${marketplace_json}" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const hit=(j.marketplaces||[]).some(m=>String(m.marketplaceSource&&m.marketplaceSource.source||"").includes("rohitg00/agentmemory")); process.exit(hit?0:1)})'; then
  codex plugin remove agentmemory@agentmemory --json || true
  codex plugin marketplace remove agentmemory --json
  rm -rf "${HOME}/.codex/plugins/cache/agentmemory"
  rm -rf "${HOME}/.codex/.tmp/marketplaces/agentmemory"
  echo "codex: removed the rohitg00/agentmemory marketplace"
fi

node --import tsx src/cli/connect/codex-user-hooks.ts --node-home "${node_home}"

rm -rf "${HOME}/.cursor/plugins/cache/agentmemory"
rm -rf "${HOME}/.cursor/plugins/marketplaces/github.com/rohitg00"
rmdir "${HOME}/.cursor/plugins/marketplaces/github.com" 2>/dev/null || true

sha="$(git rev-parse HEAD)"
claude_sha="$(git -C "${HOME}/.claude/plugins/marketplaces/agentmemory" rev-parse HEAD)"
echo "global install: ${sha}"
echo "claude plugin:  ${claude_sha}"
echo "grok plugin:    ${claude_sha}"
echo "codex hooks:    ${sha}"
echo "cursor:         mcp-only ${sha}"
