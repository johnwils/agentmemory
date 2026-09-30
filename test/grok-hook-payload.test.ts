import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { hookCwd } from "../src/hooks/_project.js";

const pluginRoot = join(resolve(__dirname, ".."), "plugin");

type ObservedRequest = { path: string; body: Record<string, unknown> };

// Grok's stdin envelope: camelCase keys, hook_event_name carrying Claude's
// PascalCase value, and tool output on toolResult (tool_response is the alias).
const grokPostToolUse = {
  hookEventName: "post_tool_use",
  hook_event_name: "PostToolUse",
  sessionId: "grok-session",
  cwd: "/Users/you/project",
  workspaceRoot: "/Users/you/project",
  permissionMode: "default",
  toolName: "run_terminal_command",
  toolInput: { command: "npm test" },
  toolUseId: "tu_1",
  toolResult: { type: "Bash", output: "ok" },
};

async function runHook(
  script: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ requests: ObservedRequest[]; stdout: string }> {
  const requests: ObservedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ context: "remembered context" }));
    });
  });

  await new Promise<void>((resolveServer) => {
    server.listen(0, "127.0.0.1", resolveServer);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind to a TCP port");
  }

  try {
    const child = spawn(process.execPath, [join(pluginRoot, script)], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"],
        AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
        AGENTMEMORY_SECRET: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(JSON.stringify(payload));

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`hook ${script} timed out`));
      }, 5000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });

    expect(exitCode, stderr).toBe(0);
    return { requests, stdout };
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
}

describe("Grok hook payload", () => {
  it("post-tool-use records toolInput when the payload has no tool_input or toolArgs", async () => {
    const result = await runHook("scripts/post-tool-use.mjs", grokPostToolUse);

    expect(result.requests[0]?.path).toBe("/agentmemory/observe");
    expect(result.requests[0]?.body).toMatchObject({
      hookType: "post_tool_use",
      sessionId: "grok-session",
      data: {
        tool_name: "run_terminal_command",
        tool_input: { command: "npm test" },
        tool_output: { type: "Bash", output: "ok" },
      },
    });
  });

  it("post-tool-failure records toolInput", async () => {
    const result = await runHook("scripts/post-tool-failure.mjs", {
      hookEventName: "post_tool_use_failure",
      hook_event_name: "PostToolUseFailure",
      sessionId: "grok-session",
      cwd: "/Users/you/project",
      toolName: "read_file",
      toolInput: { target_file: "docs/hub.md" },
      error: "not found",
    });

    expect(result.requests[0]?.body).toMatchObject({
      hookType: "post_tool_failure",
      sessionId: "grok-session",
      data: {
        tool_name: "read_file",
        tool_input: JSON.stringify({ target_file: "docs/hub.md" }),
        error: "not found",
      },
    });
  });

  it("subagent-start records agentId and subagentType", async () => {
    const result = await runHook("scripts/subagent-start.mjs", {
      hookEventName: "subagent_start",
      hook_event_name: "SubagentStart",
      sessionId: "grok-session",
      cwd: "/Users/you/project",
      agentId: "agent-1",
      subagentType: "explore",
    });

    expect(result.requests[0]?.body).toMatchObject({
      hookType: "subagent_start",
      sessionId: "grok-session",
      data: { agent_id: "agent-1", agent_type: "explore" },
    });
  });

  it("subagent-stop records subagentType and lastAssistantMessage", async () => {
    const result = await runHook("scripts/subagent-stop.mjs", {
      hookEventName: "subagent_stop",
      hook_event_name: "SubagentStop",
      sessionId: "grok-session",
      cwd: "/Users/you/project",
      agentId: "agent-1",
      subagentType: "explore",
      lastAssistantMessage: "found the field",
    });

    expect(result.requests[0]?.body).toMatchObject({
      hookType: "subagent_stop",
      sessionId: "grok-session",
      data: {
        agent_id: "agent-1",
        agent_type: "explore",
        last_message: "found the field",
      },
    });
  });

  it("pre-tool-use reads toolInput and emits PreToolUse additionalContext", async () => {
    const result = await runHook(
      "scripts/pre-tool-use.mjs",
      {
        hookEventName: "pre_tool_use",
        hook_event_name: "PreToolUse",
        sessionId: "grok-session",
        cwd: "/Users/you/project",
        workspaceRoot: "/Users/you/project",
        permissionMode: "default",
        toolName: "grep",
        toolInput: { pattern: "toolInput", path: "src/hooks/post-tool-use.ts" },
        toolUseId: "tu_2",
      },
      { AGENTMEMORY_INJECT_CONTEXT: "true" },
    );

    expect(result.requests[0]?.path).toBe("/agentmemory/enrich");
    expect(result.requests[0]?.body).toMatchObject({
      sessionId: "grok-session",
      files: ["src/hooks/post-tool-use.ts"],
      terms: ["toolInput"],
      toolName: "grep",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "remembered context",
      },
    });
  });

  it("hookCwd falls back to workspaceRoot when cwd is absent", () => {
    expect(hookCwd({ workspaceRoot: "  /Users/you/project  " })).toBe(
      "/Users/you/project",
    );
    expect(hookCwd({ cwd: "/real", workspaceRoot: "/other" })).toBe("/real");
  });
});
