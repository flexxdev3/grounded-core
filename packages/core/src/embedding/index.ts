import { ConfigError } from "../contract.js";
import type { EmbeddingProvider, GroundedConfig } from "../contract.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAiProvider } from "./openai.js";
import { createNoneProvider } from "./none.js";

export function createEmbeddingProvider(cfg: GroundedConfig): EmbeddingProvider {
  switch (cfg.embeddings.provider) {
    case "ollama":
      return createOllamaProvider(cfg);
    case "openai":
      return createOpenAiProvider(cfg);
    case "none":
      return createNoneProvider();
    default:
      throw new ConfigError(`unknown embedding provider: ${String(cfg.embeddings.provider)}`);
  }
}
