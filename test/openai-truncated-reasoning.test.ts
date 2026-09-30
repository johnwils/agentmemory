import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";

function stubChoice(choice: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ choices: [choice] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("OpenAIProvider truncated reasoning (#1393)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when finish_reason is length and only partial reasoning came back", async () => {
    stubChoice({
      finish_reason: "length",
      message: { content: null, reasoning: "The user is asking me to reply with exactly" },
    });
    const provider = new OpenAIProvider("key", "general", 16, "http://broker:4010/v1");
    await expect(provider.summarize("s", "u")).rejects.toThrow(/truncated/);
  });

  it("still returns reasoning for a completed response with no content (#627)", async () => {
    stubChoice({
      finish_reason: "stop",
      message: { content: "", reasoning_content: "<summary>done</summary>" },
    });
    const provider = new OpenAIProvider("key", "general", 4096, "http://broker:4010/v1");
    await expect(provider.summarize("s", "u")).resolves.toBe("<summary>done</summary>");
  });
});
