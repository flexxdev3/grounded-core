import type { EmbeddingProvider } from "../contract.js";

export function createNoneProvider(): EmbeddingProvider {
  return {
    id: "none",
    dims: 0,
    enabled: false,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => []);
    },
    async health(): Promise<{ ok: boolean; detail?: string }> {
      return { ok: true, detail: "lexical-only" };
    },
  };
}
