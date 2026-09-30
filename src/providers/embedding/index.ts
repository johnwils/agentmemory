import type { EmbeddingProvider } from "../../types.js";
import { detectEmbeddingProvider, getEnvVar } from "../../config.js";
import { GeminiEmbeddingProvider } from "./gemini.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import { VOYAGE_DEFAULT_MODEL, VoyageEmbeddingProvider } from "./voyage.js";
import { CohereEmbeddingProvider } from "./cohere.js";
import { OpenRouterEmbeddingProvider } from "./openrouter.js";
import { LocalEmbeddingProvider } from "./local.js";
import { ClipEmbeddingProvider } from "./clip.js";

export {
  GeminiEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  CohereEmbeddingProvider,
  OpenRouterEmbeddingProvider,
  LocalEmbeddingProvider,
  ClipEmbeddingProvider,
};

// The identity a stored vector is valid for. Two models behind one provider
// name produce incomparable vector spaces even at equal dimensions
// (voyage-code-3 vs voyage-code-4), so the name alone is not enough.
export function embeddingModelId(provider: Pick<EmbeddingProvider, "name" | "model">): string {
  return provider.model ? `${provider.name}:${provider.model}` : provider.name;
}

// The model behind an index written before indexes carried a model tag, or
// null when that cannot be known. Voyage's model was hard-coded to
// voyage-code-3 until VOYAGE_EMBEDDING_MODEL existed; the other providers
// already read their model from the environment, so an untagged index of
// theirs is taken to match the active one.
export function untaggedModelId(providerName: string): string | null {
  return providerName === "voyage" ? `voyage:${VOYAGE_DEFAULT_MODEL}` : null;
}

let imageEmbeddingProvider: EmbeddingProvider | null = null;

export function createImageEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] !== "true") return null;
  if (imageEmbeddingProvider) return imageEmbeddingProvider;
  imageEmbeddingProvider = withEmbeddingGuards(new ClipEmbeddingProvider());
  return imageEmbeddingProvider;
}

export function createEmbeddingProvider(): EmbeddingProvider | null {
  const detected = detectEmbeddingProvider();
  if (!detected) return null;

  switch (detected) {
    case "gemini":
      return withEmbeddingGuards(new GeminiEmbeddingProvider(getEnvVar("GEMINI_API_KEY")!));
    case "openai":
      return withEmbeddingGuards(new OpenAIEmbeddingProvider());
    case "voyage":
      return withEmbeddingGuards(new VoyageEmbeddingProvider(getEnvVar("VOYAGE_API_KEY")!));
    case "cohere":
      return withEmbeddingGuards(new CohereEmbeddingProvider(getEnvVar("COHERE_API_KEY")!));
    case "openrouter":
      return withEmbeddingGuards(new OpenRouterEmbeddingProvider(getEnvVar("OPENROUTER_API_KEY")!));
    case "local":
      return withEmbeddingGuards(new LocalEmbeddingProvider());
    default:
      return null;
  }
}

// Wrong-dimension vectors corrupt the index silently: vector-index.ts
// returns 0 from cosineSimilarity on length mismatch instead of throwing,
// so a bad vector is stored, never matches anything, and the memory
// becomes invisible without an error. Catch it at the boundary.
// A lone surrogate, left by any cut that counts UTF-16 units, makes the
// provider reject the whole request, so input is made well-formed here too.
export function withEmbeddingGuards(provider: EmbeddingProvider): EmbeddingProvider {
  const expected = provider.dimensions;
  const check = (v: Float32Array, where: string): Float32Array => {
    if (v.length !== expected) {
      throw new Error(
        `Embedding dimension mismatch in ${provider.name}.${where}: expected ${expected}, got ${v.length}`,
      );
    }
    return v;
  };
  // Preserve the provider's prototype chain so `instanceof` checks
  // against concrete classes (e.g. GeminiEmbeddingProvider) keep working.
  const wrapped = Object.create(provider) as EmbeddingProvider;
  wrapped.embed = async (t) => check(await provider.embed(t.toWellFormed()), "embed");
  wrapped.embedBatch = async (ts) => {
    const out = await provider.embedBatch(ts.map((t) => t.toWellFormed()));
    out.forEach((v, i) => check(v, `embedBatch[${i}]`));
    return out;
  };
  if (provider.embedImage) {
    wrapped.embedImage = async (s: string) =>
      check(await provider.embedImage!(s), "embedImage");
  }
  return wrapped;
}
