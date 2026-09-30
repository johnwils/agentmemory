# Client smoke test

Paste this into a fresh Claude Code, Codex, Grok or Cursor session after a hub deploy or a clients/update-mac.sh run. Cursor has capture through the imported Claude plugin.

```markdown
# Task: smoke-test agentmemory from this agent and give a thumbs up or down

You are one of my coding agents (Claude Code, Codex, Grok or Cursor). My shared memory server runs on my LAN hub and you reach it through the `agentmemory` MCP tools. Test it end to end WITHOUT changing any configuration. Say which agent and model you are.

1. List the agentmemory MCP tools available to you (count them; the expected total is 55 when all tools are exposed; Codex may expose a subset by config).
2. `memory_smart_search` for "voyage-code-4 SQLite migration" (limit 3): expect results.
3. `memory_recall` or `memory_sessions`: expect recent sessions listed.
4. `memory_slot_list` and `memory_lesson_recall` (any query): expect a response, not an error.
5. Write, find, delete:
   - `memory_save` a memory with title `smoke-test <agent> <UTC timestamp>` and content `temporary smoke test, safe to delete`.
   - `memory_smart_search` for that title: it must be found.
   - Delete it with `memory_governance_delete` (or the delete tool you have), then search again and confirm it is gone.
6. Capture check: run one harmless shell command (`echo smoke-capture-<random>`) and read one small file. Then find THIS session with `memory_sessions` or `memory_timeline`, and confirm those two tool calls were captured with their inputs (the echo text and the file path). Capture can lag a few seconds; retry once. If capture is missing, report it rather than failing.
7. If any MCP call fails, report the exact error text.

Report back (paste-ready, under 150 words): agent and model; a table with each step (1 to 6) as pass, fail or n/a, plus a short note; the session id; then a final line with 👍 or 👎.
```
