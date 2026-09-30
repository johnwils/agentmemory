# Hub deployment

One agentmemory daemon on the LAN hub (`hub`, 192.168.68.52) serves every coding agent on the Mac:
Claude Code (plugin hooks + MCP), Codex, Cursor and Grok (MCP via `~/.agentmemory/mcp-launch.sh`),
and Grok capture via `~/Documents/dev/agentmemory-grok`. Clients reach it at
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
It runs `VACUUM INTO` inside the container (one read transaction, consistent while the daemon
writes), checks the copy with `PRAGMA quick_check`, and gzips it. About 300 MB each, growing
roughly 10 MB a day.

Restore: `docker compose down`, `gunzip -c backups/<file>.gz > data/agentmemory.sqlite`, delete
`data/agentmemory.sqlite-wal` and `-shm`, `chown 1000:1000 data/agentmemory.sqlite`, `docker compose up -d`.

## History

On 2026-09-30 the hub moved from upstream `@agentmemory/agentmemory` 0.9.29 on the iii engine to
this fork. That day the iii vectors were first re-embedded with voyage-code-4. The store was then
imported with `node dist/import-state-store.mjs --include-graph --include-audit`: 71,557 vectors,
and every scope's count and digest matched. The iii stack and its data were deleted after the
cutover; the SQLite store and its backups are the only copies.
