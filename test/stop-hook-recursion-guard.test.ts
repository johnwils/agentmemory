import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldSkipHooks } from "../src/hooks/sdk-guard.js";
import { NoopProvider } from "../src/providers/noop.js";

describe("shouldSkipHooks — recursion guard and headless skip", () => {
  const originalChild = process.env.AGENTMEMORY_SDK_CHILD;
  const originalHeadless = process.env.AGENTMEMORY_CAPTURE_HEADLESS;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_SDK_CHILD;
    delete process.env.AGENTMEMORY_CAPTURE_HEADLESS;
  });

  afterEach(() => {
    for (const [key, value] of [
      ["AGENTMEMORY_SDK_CHILD", originalChild],
      ["AGENTMEMORY_CAPTURE_HEADLESS", originalHeadless],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns true when AGENTMEMORY_SDK_CHILD=1 is in env", () => {
    process.env.AGENTMEMORY_SDK_CHILD = "1";
    expect(shouldSkipHooks({})).toBe(true);
  });

  it.each(["sdk-ts", "sdk-py", "sdk-cli"])("skips a headless %s Session by default", (entrypoint) => {
    expect(shouldSkipHooks({ entrypoint })).toBe(true);
  });

  it("returns false for an interactive CC payload", () => {
    expect(shouldSkipHooks({ entrypoint: "cli", session_id: "s1" })).toBe(false);
  });

  it("returns false when payload is null / undefined / non-object", () => {
    expect(shouldSkipHooks(null)).toBe(false);
    expect(shouldSkipHooks(undefined)).toBe(false);
    expect(shouldSkipHooks("not-an-object")).toBe(false);
    expect(shouldSkipHooks(42)).toBe(false);
  });

  it("env marker wins over payload shape", () => {
    process.env.AGENTMEMORY_SDK_CHILD = "1";
    expect(shouldSkipHooks({ entrypoint: "cli" })).toBe(true);
  });

  it("AGENTMEMORY_CAPTURE_HEADLESS=1 captures headless Sessions", () => {
    process.env.AGENTMEMORY_CAPTURE_HEADLESS = "1";
    expect(shouldSkipHooks({ entrypoint: "sdk-cli" })).toBe(false);
  });

  it("AGENTMEMORY_CAPTURE_HEADLESS=1 never re-enables the recursion guard", () => {
    process.env.AGENTMEMORY_CAPTURE_HEADLESS = "1";
    process.env.AGENTMEMORY_SDK_CHILD = "1";
    expect(shouldSkipHooks({ entrypoint: "sdk-ts" })).toBe(true);
  });
});

describe("NoopProvider — no-op fallback when no LLM key present", () => {
  it("reports name 'noop' so callers can detect it and short-circuit", () => {
    const p = new NoopProvider();
    expect(p.name).toBe("noop");
  });

  it("returns empty string for compress and summarize", async () => {
    const p = new NoopProvider();
    await expect(p.compress()).resolves.toBe("");
    await expect(p.summarize()).resolves.toBe("");
  });
});
