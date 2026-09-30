# Hub deployment

One agentmemory daemon on the LAN hub (`hub`, 192.168.68.52) serves every coding agent on the Mac:
Claude Code, Codex, Cursor, and Grok. Clients reach it at
`http://192.168.68.52:3111` with the secret in the hub's `data/.hmac`; the viewer is on `:3113`.

## Layout on the hub: `/opt/agentmemory`

| Path | What |
|---|---|
| `compose.yml` | copy of `docker/hub/compose.yml` |
| `.env` | `AGENTMEMORY_TAG=<short sha>`: the image to run |
| `agentmemory.env` | daemon environment, root-only (keys, models, viewer hosts). Not in git. |
| `data/agentmemory.sqlite` | the whole store: KV rows and vectors, WAL mode |
| `data/.hmac` | REST secret; the entrypoint exports it as `AGENTMEMORY_SECRET` and it wins over the environment |
| `backup.sh`, `backups/` | copy of `docker/hub/backup.sh`; nightly gzipped copies, newest 7 kept |

`agentmemory.env` pins two settings the fork would otherwise turn on: `CONSOLIDATION_ENABLED=false`
(an LLM pass on every session stop) and `EVICTION_ENABLED=false` (daily deletion of old observations).
Embeddings: `EMBEDDING_PROVIDER=voyage`, `VOYAGE_EMBEDDING_MODEL=voyage-code-4`. The store records the
model its vectors came from and refuses to start under a different one
(`AGENTMEMORY_DROP_STALE_INDEX=true` empties the vectors instead; the hourly fill pass re-embeds).

## Deploy a new build

```sh
# on the hub
git clone --depth 1 https://github.com/johnwils/agentmemory.git /tmp/am && cd /tmp/am
sudo docker build -t agentmemory:$(git rev-parse --short HEAD) .
cd /opt/agentmemory && echo "AGENTMEMORY_TAG=<short sha>" > .env && sudo docker compose up -d
curl -s http://127.0.0.1:3111/agentmemory/readyz   # 200 when serving
```

A stop is graceful (60 s grace). SQLite commits every write, so even a hard kill loses at most
vectors that were still being embedded; the fill pass at boot and hourly re-embeds them.

## Backups

`/etc/cron.d/agentmemory-backup` runs `backup.sh` at 03:30 (log: `/var/log/agentmemory-backup.log`).
It calls the daemon's `POST /agentmemory/backup`: a `VACUUM INTO` snapshot (one read transaction,
consistent while the daemon writes) checked with `integrity_check` and row counts against the live
store. The script gzips it and keeps the newest 7. About 300 MB each, growing
roughly 10 MB a day.

Restore: `docker compose down`, `gunzip -c backups/<file>.gz > data/agentmemory.sqlite`, delete
`data/agentmemory.sqlite-wal` and `-shm`, `chown 1000:1000 data/agentmemory.sqlite`, `docker compose up -d`.

## Clients (on the Mac)

All clients run code from this repository. Update them with:

```sh
~/Documents/dev/agentmemory/clients/update-mac.sh
```

The script pulls this checkout, runs `npm ci`, `npm run build`, and `npm pack`, then
global-installs that tarball with fnm's default Node (the path `npm pack` prints, so a
`ls` alias cannot expand the filename). It copies `clients/mcp-launch.sh` onto
`~/.agentmemory/mcp-launch.sh`, reinstalls the Claude plugin, refreshes Codex hooks, and
prints the commit each client is running.

- **MCP (Codex and Cursor):** `~/.agentmemory/mcp-launch.sh` loads
  `~/.agentmemory/.env` (`AGENTMEMORY_URL`, `AGENTMEMORY_SECRET`) and runs the installed
  `dist/standalone.mjs` as a proxy to the hub. Each client registers that server once.
- **Claude Code and Grok:** the plugin from this repository's marketplace
  (`claude plugin marketplace add johnwils/agentmemory`, then `claude plugin install agentmemory@agentmemory`).
  Grok discovers that install. Enable `agentmemory@agentmemory` in `~/.grok/config.toml`
  `[plugins].enabled`, and do not also declare `[mcp_servers.agentmemory]`.
  It runs `hooks/hooks.json` with `CLAUDE_PLUGIN_ROOT` set and attaches `.mcp.json`, which
  starts the same launcher. The plugin-root `plugin.json` leaves `hooks` and `mcpServers`
  unset; if those fields are set, Grok follows them and loads Copilot's files instead.
  The version string stays `0.9.29`, so the script uninstalls and reinstalls the plugin
  after `claude plugin marketplace update agentmemory`.
- **Codex capture:** the CLI and Desktop (Codex inside ChatGPT.app) share `~/.codex`.
  Codex 0.159 removed the `plugin_hooks` feature, so a marketplace plugin's
  `hooks/hooks.codex.json` does not run. The script merges that manifest into
  `~/.codex/hooks.json` (other hooks in the file stay), points `node` at fnm's default
  binary, and records hook trust for the commands it wrote. MCP stays the single
  `[mcp_servers.agentmemory]` entry. A marketplace whose git source is
  `rohitg00/agentmemory` is removed. There is no `plugin/.codex-plugin/plugin.json`:
  Codex does not dispatch it.
- **Cursor capture:** Cursor's installed plugin list does not include agentmemory, and
  Grok also reads `~/.cursor/hooks.json`, so agentmemory hooks stay out of that file and
  out of `~/.claude/settings.json`. Cursor is MCP only. The script deletes a leftover
  `rohitg00/agentmemory` plugin cache when one is present.
- Hook scripts accept Grok's camelCase fields (`toolInput`, `sessionId`, `toolName`,
  `toolResult`, `subagentType`, `agentId`, `lastAssistantMessage`, `workspaceRoot`)
  alongside Claude's and Codex's snake_case names (`session_id`, `tool_name`,
  `tool_input`, `tool_response`, `prompt`).

| What changed | What to run |
|---|---|
| Server code (the daemon, its store, the hub image) | Redeploy on the hub. The script does not touch the hub. |
| Client code (the MCP proxy, hook scripts, the Claude plugin) | `clients/update-mac.sh` |
| Docs only | Nothing |

Hook scripts skip headless sessions (`claude -p`, Agent SDK) by default. `grok --single` is not that skip.

## History

On 2026-09-30 the hub moved from upstream `@agentmemory/agentmemory` 0.9.29 on the iii engine to
this fork. That day the iii vectors were first re-embedded with voyage-code-4. The store was then
imported with `node dist/import-state-store.mjs --include-graph --include-audit`: 71,557 vectors,
and every scope's count and digest matched. The iii stack and its data were deleted after the
cutover; the SQLite store and its backups are the only copies.
