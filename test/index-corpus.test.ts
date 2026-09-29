import { describe, it, expect } from "vitest";
import { clipEmbedInput } from "../src/state/index-corpus.js";

describe("clipEmbedInput", () => {
  it("replaces a lone surrogate the provider would reject", () => {
    expect(clipEmbedInput("Bash \uDC00 ls")).toBe("Bash � ls");
  });

  it("does not leave half a pair when the clip lands inside one", () => {
    const text = "a".repeat(15_999) + "😀";
    const clipped = clipEmbedInput(text);
    expect(clipped).toHaveLength(16_000);
    expect(clipped.isWellFormed()).toBe(true);
  });

  it("keeps well-formed text unchanged", () => {
    expect(clipEmbedInput("smile 😀")).toBe("smile 😀");
  });
});
