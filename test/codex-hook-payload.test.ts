import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = join(resolve(__dirname, ".."), "plugin");

type ObservedRequest = { path: string; body: Record<string, unknown> };

async function runHook(
  script: string,
  payload: Record<string, unknown>,
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
      res.end(JSON.stringify({ context: "" }));
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

const codexCommon = {
  session_id: "thr_123",
  transcript_path: null,
  cwd: "/Users/you/project",
  model: "gpt-5.4",
};

describe("Codex hook payload", () => {
  it("post-tool-use records snake_case tool_input and tool_response", async () => {
    const result = await runHook("scripts/post-tool-use.mjs", {
      ...codexCommon,
      hook_event_name: "PostToolUse",
      turn_id: "turn_456",
      tool_name: "Bash",
      tool_use_id: "call_789",
      tool_input: { command: "git status" },
      tool_response: { output: "ok", exit_code: 0 },
    });

    expect(result.requests[0]?.path).toBe("/agentmemory/observe");
    expect(result.requests[0]?.body).toMatchObject({
      hookType: "post_tool_use",
      sessionId: "thr_123",
      data: {
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_output: { output: "ok", exit_code: 0 },
      },
    });
  });

  it("prompt-submit records the prompt field", async () => {
    const result = await runHook("scripts/prompt-submit.mjs", {
      ...codexCommon,
      hook_event_name: "UserPromptSubmit",
      prompt: "remember the port",
    });

    expect(result.requests[0]?.body).toMatchObject({
      hookType: "prompt_submit",
      sessionId: "thr_123",
      data: { prompt: "remember the port" },
    });
  });

  it("session-start registers session_id", async () => {
    const result = await runHook("scripts/session-start.mjs", {
      ...codexCommon,
      hook_event_name: "SessionStart",
      source: "startup",
    });

    expect(result.requests[0]?.path).toBe("/agentmemory/session/start");
    expect(result.requests[0]?.body).toMatchObject({
      sessionId: "thr_123",
      cwd: "/Users/you/project",
    });
  });
});
