import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMergedHooks, type HookManifest } from "./codex-hooks.js";

// Codex 0.159 hashes a normalized hook identity: canonical JSON of
// { event_name, matcher?, hooks: [{ async, command, timeout, type, statusMessage? }] },
// then sha256. Omitted timeouts are stored as 600. See
// codex-rs/hooks/src/engine/discovery.rs hook_hash and
// codex-rs/config/src/fingerprint.rs version_for_toml at rust-v0.159.2.
const EVENT_LABEL: Record<string, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

const SECTION_HEADER = /^\[hooks\.state\."([^"]+)"\]\s*$/;

type HashHandler = {
  type?: string;
  command: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
};

export type CodexHooksInstallResult = {
  hooksPath: string;
  trust: "updated" | "skipped" | "needs-review";
};

export function hookTrustHash(
  eventLabel: string,
  matcher: string | undefined,
  handler: HashHandler,
): string {
  const body: Record<string, unknown> = {
    async: handler.async === true,
    command: handler.command,
    timeout: typeof handler.timeout === "number" ? handler.timeout : 600,
    type: handler.type ?? "command",
  };
  if (typeof handler.statusMessage === "string") body.statusMessage = handler.statusMessage;
  const identity: Record<string, unknown> = {
    event_name: eventLabel,
    hooks: [body],
  };
  if (matcher) identity.matcher = matcher;
  const serialized = JSON.stringify(canonical(identity));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function parseHookTrust(toml: string): Map<string, string> {
  const map = new Map<string, string>();
  let key: string | null = null;
  for (const line of toml.split("\n")) {
    const header = SECTION_HEADER.exec(line);
    if (header) {
      key = header[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      key = null;
      continue;
    }
    if (!key) continue;
    const hash = /^trusted_hash\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (hash) map.set(key, hash[1]);
  }
  return map;
}

export function dropHookTrustPrefixes(toml: string, prefixes: string[]): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const header = SECTION_HEADER.exec(line);
    if (header) {
      skipping = prefixes.some((prefix) => header[1].startsWith(prefix));
      if (skipping) continue;
    } else if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function upsertHookTrust(
  toml: string,
  updates: ReadonlyArray<{ key: string; hash: string }>,
): string {
  const pending = new Map(updates.map((update) => [update.key, update.hash]));
  const out: string[] = [];
  let current: string | null = null;
  for (const line of toml.split("\n")) {
    const header = SECTION_HEADER.exec(line);
    if (header) {
      current = pending.has(header[1]) ? header[1] : null;
      out.push(line);
      continue;
    }
    if (/^\s*\[/.test(line)) current = null;
    if (current && /^trusted_hash\s*=/.test(line)) {
      out.push(`trusted_hash = "${pending.get(current)}"`);
      pending.delete(current);
      current = null;
      continue;
    }
    out.push(line);
  }
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  for (const [key, hash] of pending) {
    const headerLine = `[hooks.state."${key}"]`;
    if (text.includes(`${headerLine}\n`)) {
      text = text.replace(`${headerLine}\n`, `${headerLine}\ntrusted_hash = "${hash}"\n`);
    } else {
      text += `\n${headerLine}\ntrusted_hash = "${hash}"\n`;
    }
  }
  return text;
}

export function installCodexUserHooks(opts: {
  nodeHome: string;
  codexDir: string;
  pluginRoot: string;
}): CodexHooksInstallResult {
  const scriptsDir = join(opts.pluginRoot, "scripts");
  const nodeBin = join(opts.nodeHome, "bin", "node");
  const hooksPath = join(opts.codexDir, "hooks.json");
  const configPath = join(opts.codexDir, "config.toml");
  mkdirSync(opts.codexDir, { recursive: true });

  let rawExisting: Record<string, unknown> | null = null;
  if (existsSync(hooksPath)) {
    rawExisting = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
  }
  const merged = buildMergedHooks(
    rawExisting as HookManifest | null,
    opts.pluginRoot,
  );
  for (const entries of Object.values(merged.hooks)) {
    for (const entry of entries) {
      for (const handler of entry.hooks) {
        if (handler.command.includes(scriptsDir) && handler.command.startsWith("node ")) {
          handler.command = `"${nodeBin}" ${handler.command.slice("node ".length)}`;
        }
      }
    }
  }
  const written = rawExisting
    ? { ...rawExisting, hooks: merged.hooks }
    : { hooks: merged.hooks };
  writeFileSync(hooksPath, `${JSON.stringify(written, null, 2)}\n`);

  if (!existsSync(configPath)) return { hooksPath, trust: "skipped" };

  let toml = dropHookTrustPrefixes(readFileSync(configPath, "utf8"), [
    "agentmemory@agentmemory:",
  ]);
  const stored = parseHookTrust(toml);
  const updates: { key: string; hash: string }[] = [];
  let algorithmOk = true;
  for (const [event, entries] of Object.entries(merged.hooks)) {
    const label = EVENT_LABEL[event];
    if (!label) continue;
    entries.forEach((entry, groupIndex) => {
      entry.hooks.forEach((handler, handlerIndex) => {
        const record = handler as HashHandler;
        const key = `${hooksPath}:${label}:${groupIndex}:${handlerIndex}`;
        const hash = hookTrustHash(label, entry.matcher, record);
        if (record.command.includes(scriptsDir)) {
          updates.push({ key, hash });
          return;
        }
        const previous = stored.get(key);
        if (previous !== undefined && previous !== hash) algorithmOk = false;
      });
    });
  }
  if (!algorithmOk) {
    writeFileSync(configPath, toml.endsWith("\n") ? toml : `${toml}\n`);
    return { hooksPath, trust: "needs-review" };
  }
  toml = upsertHookTrust(toml, updates);
  writeFileSync(configPath, toml);
  return { hooksPath, trust: "updated" };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const nodeHomeFlag = process.argv.indexOf("--node-home");
  const nodeHome =
    nodeHomeFlag >= 0 && process.argv[nodeHomeFlag + 1]
      ? process.argv[nodeHomeFlag + 1]
      : join(homedir(), ".local/share/fnm/aliases/default");
  const codexDir = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const pluginRoot = join(
    nodeHome,
    "lib/node_modules/@agentmemory/agentmemory/plugin",
  );
  if (!existsSync(join(pluginRoot, "hooks", "hooks.codex.json"))) {
    console.error(`codex hooks: plugin manifest missing at ${pluginRoot}`);
    process.exit(1);
  }
  const result = installCodexUserHooks({ nodeHome, codexDir, pluginRoot });
  console.log(`codex hooks: ${result.hooksPath} trust=${result.trust}`);
}
