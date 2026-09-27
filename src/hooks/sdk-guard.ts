/**
 * Skip guard shared by every hook script.
 *
 * Two kinds of Session never reach agentmemory:
 *
 *   1. agentmemory's own summarize/compress calls. The agent-sdk provider
 *      sets AGENTMEMORY_SDK_CHILD=1 before it spawns `query()`, and the
 *      child inherits it. Capturing that child would summarize it through
 *      the same provider and recurse without bound (#149 follow-up). This
 *      skip is unconditional.
 *   2. Headless Sessions: `claude -p` (entrypoint "sdk-cli"), the TS Agent
 *      SDK ("sdk-ts") and the Python Agent SDK ("sdk-py"). These are almost
 *      always scripted batches whose summaries are noise, and a batch of
 *      thousands saturates the summarizing LLM. Set
 *      AGENTMEMORY_CAPTURE_HEADLESS=1 to capture them.
 *
 * Hook scripts must call shouldSkipHooks(payload) EARLY and return
 * silently when it is true.
 */
export function shouldSkipHooks(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (process.env["AGENTMEMORY_CAPTURE_HEADLESS"] === "1") return false;
  if (!payload || typeof payload !== "object") return false;
  const entrypoint = (payload as { entrypoint?: unknown }).entrypoint;
  return typeof entrypoint === "string" && entrypoint.startsWith("sdk-");
}
