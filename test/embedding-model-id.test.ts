import { afterEach, describe, expect, it, vi } from "vitest";
import { VoyageEmbeddingProvider } from "../src/providers/embedding/voyage.js";
import {
  embeddingModelId,
  untaggedModelId,
  withEmbeddingGuards,
} from "../src/providers/embedding/index.js";

function voyageResponse(n: number): Response {
  return new Response(
    JSON.stringify({ data: Array.from({ length: n }, () => ({ embedding: new Array(1024).fill(0.5) })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Voyage embedding model", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("defaults to voyage-code-3, the model it always used", async () => {
    vi.stubEnv("VOYAGE_EMBEDDING_MODEL", "");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(voyageResponse(1));
    const p = new VoyageEmbeddingProvider("pa-test");
    expect(p.model).toBe("voyage-code-3");
    await p.embed("hello");
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).model).toBe("voyage-code-3");
  });

  it("sends the model named by VOYAGE_EMBEDDING_MODEL", async () => {
    vi.stubEnv("VOYAGE_EMBEDDING_MODEL", " voyage-code-4 ");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(voyageResponse(2));
    const p = new VoyageEmbeddingProvider("pa-test");
    expect(p.model).toBe("voyage-code-4");
    await p.embedBatch(["a", "b"]);
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).model).toBe("voyage-code-4");
  });
});

describe("embeddingModelId", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is provider:model, surviving the guard wrapper", () => {
    vi.stubEnv("VOYAGE_EMBEDDING_MODEL", "voyage-code-4");
    const wrapped = withEmbeddingGuards(new VoyageEmbeddingProvider("pa-test"));
    expect(embeddingModelId(wrapped)).toBe("voyage:voyage-code-4");
  });

  it("is the bare name for a provider without a model", () => {
    expect(embeddingModelId({ name: "custom" })).toBe("custom");
  });

  it("treats an untagged Voyage index as voyage-code-3 and others as unknown", () => {
    expect(untaggedModelId("voyage")).toBe("voyage:voyage-code-3");
    expect(untaggedModelId("openai")).toBeNull();
  });
});
