import { EmbedError } from "../contract.js";
import type { EmbeddingProvider, GroundedConfig } from "../contract.js";

export function createOpenAiProvider(cfg: GroundedConfig): EmbeddingProvider {
  const baseUrl = (cfg.embeddings.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const model = cfg.embeddings.model ?? "text-embedding-3-small";
  const dims = cfg.embeddings.dims ?? 1536;
  const apiKey = cfg.embeddings.apiKey ?? "";

  return {
    id: `openai:${model}`,
    dims,
    enabled: true,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      if (!apiKey) throw new EmbedError("openai provider requires an apiKey");
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: texts }),
        });
      } catch (err) {
        throw new EmbedError(`openai embed request failed: ${(err as Error).message}`);
      }
      if (!res.ok) {
        throw new EmbedError(`openai embed returned ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as {
        data?: { index: number; embedding: number[] }[];
      };
      if (!Array.isArray(json.data)) {
        throw new EmbedError("openai embed response missing data");
      }
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    },
    async health(): Promise<{ ok: boolean; detail?: string }> {
      if (!apiKey) return { ok: false, detail: "missing apiKey" };
      return { ok: true, detail: `openai:${model}` };
    },
  };
}
