import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dropHookTrustPrefixes,
  hookTrustHash,
  installCodexUserHooks,
  parseHookTrust,
  upsertHookTrust,
} from "../src/cli/connect/codex-user-hooks.js";

const PLUGIN_ROOT = resolve(__dirname, "..", "plugin");

describe("hookTrustHash", () => {
  it("matches Codex 0.159 trust hashes", () => {
    expect(
      hookTrustHash("user_prompt_submit", undefined, {
        command: "echo hi",
        timeout: 5,
        type: "command",
      }),
    ).toBe("sha256:c84163e232e754e50a34ceb5974474e1c22b7f4d562b198ff40bbcdd0928ffac");

    expect(
      hookTrustHash("pre_tool_use", "Edit|Write", {
        command: "node script.mjs",
        type: "command",
      }),
    ).toBe("sha256:5a6d420eafa793ae0ab9d211f56f6b64b3788a6b8685e21693efdab38fbbc567");

    expect(
      hookTrustHash("session_start", undefined, {
        command: 'node "/opt/plugin/scripts/session-start.mjs"',
        statusMessage: "loading",
        type: "command",
      }),
    ).toBe("sha256:0101a485f11f4a4ea968696460b04c71897a1b72fc65893246fbcbb5a3931107");

    expect(
      hookTrustHash("user_prompt_submit", undefined, {
        command: "/Users/john/.local/bin/agent-turn-notify.sh start Codex",
        timeout: 5,
        type: "command",
      }),
    ).toBe("sha256:5a29e4227954dd954faad285a948092dd2e03282e81c21fc0377356e53d88a13");
  });
});

describe("hook trust toml", () => {
  it("drops stale plugin sections and upserts a hash without touching other tables", () => {
    const original = [
      "model = \"gpt\"",
      "",
      "[hooks.state.\"agentmemory@agentmemory:hooks/hooks.codex.json:stop:0:0\"]",
      "trusted_hash = \"sha256:stale\"",
      "",
      "[hooks.state.\"/tmp/hooks.json:stop:0:0\"]",
      "trusted_hash = \"sha256:keep\"",
      "",
      "[projects.\"/tmp\"]",
      "trust_level = \"trusted\"",
      "",
    ].join("\n");
    const dropped = dropHookTrustPrefixes(original, ["agentmemory@agentmemory:"]);
    expect(dropped).not.toContain("agentmemory@agentmemory");
    expect(dropped).toContain("trust_level = \"trusted\"");
    const updated = upsertHookTrust(dropped, [
      { key: "/tmp/hooks.json:stop:0:0", hash: "sha256:keep" },
      { key: "/tmp/hooks.json:session_start:0:0", hash: "sha256:new" },
    ]);
    const parsed = parseHookTrust(updated);
    expect(parsed.get("/tmp/hooks.json:stop:0:0")).toBe("sha256:keep");
    expect(parsed.get("/tmp/hooks.json:session_start:0:0")).toBe("sha256:new");
    expect(updated).toContain("[projects.\"/tmp\"]");
  });
});

describe("installCodexUserHooks", () => {
  it("merges beside an existing hook, trusts the new commands, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-hooks-"));
    const hooksPath = join(dir, "hooks.json");
    const notify = "/Users/john/.local/bin/agent-turn-notify.sh start Codex";
    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        {
          description: "notify",
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: notify, timeout: 5 }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const notifyKey = `${hooksPath}:user_prompt_submit:0:0`;
    const notifyHash = hookTrustHash("user_prompt_submit", undefined, {
      command: notify,
      timeout: 5,
      type: "command",
    });
    writeFileSync(
      join(dir, "config.toml"),
      [
        "model = \"gpt\"",
        "",
        `[hooks.state."agentmemory@agentmemory:hooks/hooks.codex.json:stop:0:0"]`,
        `trusted_hash = "sha256:stale"`,
        "",
        `[hooks.state."${notifyKey}"]`,
        `trusted_hash = "${notifyHash}"`,
        "",
      ].join("\n"),
    );

    const nodeHome = join(dir, "node");
    const first = installCodexUserHooks({
      nodeHome,
      codexDir: dir,
      pluginRoot: PLUGIN_ROOT,
    });
    const second = installCodexUserHooks({
      nodeHome,
      codexDir: dir,
      pluginRoot: PLUGIN_ROOT,
    });

    expect(first.trust).toBe("updated");
    expect(second.trust).toBe("updated");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      description: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
    };
    expect(hooks.description).toBe("notify");
    const prompts = hooks.hooks["UserPromptSubmit"];
    expect(prompts).toHaveLength(2);
    expect(prompts[0].hooks[0].command).toBe(notify);
    expect(prompts[0].hooks[0].timeout).toBe(5);
    const promptCommand = prompts[1].hooks[0].command;
    expect(promptCommand).toBe(
      `"${join(nodeHome, "bin", "node")}" "${join(PLUGIN_ROOT, "scripts", "prompt-submit.mjs")}"`,
    );
    const trust = parseHookTrust(readFileSync(join(dir, "config.toml"), "utf8"));
    expect(trust.get(notifyKey)).toBe(notifyHash);
    expect(trust.has(`${hooksPath}:session_start:0:0`)).toBe(true);
    expect(trust.get(`${hooksPath}:user_prompt_submit:1:0`)).toBe(
      hookTrustHash("user_prompt_submit", undefined, {
        command: promptCommand,
        type: "command",
      }),
    );
    expect([...trust.keys()].some((key) => key.startsWith("agentmemory@agentmemory:"))).toBe(
      false,
    );
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain('model = "gpt"');
  });

  it("leaves trust unchanged when an existing hook hash does not match Codex's algorithm", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-hooks-mismatch-"));
    const hooksPath = join(dir, "hooks.json");
    writeFileSync(
      hooksPath,
      `${JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop", timeout: 10 }] }],
        },
      })}\n`,
    );
    writeFileSync(
      join(dir, "config.toml"),
      `[hooks.state."${hooksPath}:stop:0:0"]\ntrusted_hash = "sha256:not-the-algorithm"\n`,
    );
    const result = installCodexUserHooks({
      nodeHome: join(dir, "node"),
      codexDir: dir,
      pluginRoot: PLUGIN_ROOT,
    });
    expect(result.trust).toBe("needs-review");
    const trust = parseHookTrust(readFileSync(join(dir, "config.toml"), "utf8"));
    expect(trust.get(`${hooksPath}:stop:0:0`)).toBe("sha256:not-the-algorithm");
    expect([...trust.keys()].some((key) => key.includes("session_start"))).toBe(false);
  });
});
