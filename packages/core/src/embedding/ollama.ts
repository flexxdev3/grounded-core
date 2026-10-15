import { ConfigError, EmbedError } from "../contract.js";
import type { EmbeddingProvider, GroundedConfig } from "../contract.js";

export function createOllamaProvider(cfg: GroundedConfig): EmbeddingProvider {
  const baseUrl = (cfg.embeddings.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  const model = cfg.embeddings.model ?? "nomic-embed-text";
  const dims = cfg.embeddings.dims ?? 768;
  const device = cfg.embeddings.device ?? "auto";
  if (device !== "auto" && device !== "cpu" && device !== "gpu") {
    throw new ConfigError(`embeddings.device must be "auto", "cpu" or "gpu", got ${JSON.stringify(device)}`);
  }
  // num_gpu = layers offloaded to the GPU; 0 keeps the whole model in RAM.
  const options = device === "cpu" ? { num_gpu: 0 } : undefined;

  async function embedOne(prompt: string): Promise<number[]> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, options }),
      });
    } catch (err) {
      throw new EmbedError(`ollama embed request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new EmbedError(`ollama embed returned ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new EmbedError("ollama embed response missing embedding");
    }
    return json.embedding;
  }

  /** where ollama has the model loaded right now; undefined when it is not loaded. */
  async function loadedOn(): Promise<"gpu" | "cpu" | undefined> {
    try {
      const res = await fetch(`${baseUrl}/api/ps`);
      if (!res.ok) return undefined;
      const { models = [] } = (await res.json()) as { models?: { name: string; size_vram?: number }[] };
      const m = models.find((x) => x.name === model || x.name === `${model}:latest`);
      if (!m) return undefined;
      return (m.size_vram ?? 0) > 0 ? "gpu" : "cpu";
    } catch {
      return undefined;
    }
  }

  return {
    id: `ollama:${model}`,
    dims,
    enabled: true,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (const text of texts) {
        out.push(await embedOne(text));
      }
      return out;
    },
    async health(): Promise<{ ok: boolean; detail?: string; device?: "gpu" | "cpu" }> {
      try {
        const res = await fetch(`${baseUrl}/api/tags`);
        if (!res.ok) return { ok: false, detail: `ollama ${res.status}` };
        const where = device === "cpu" ? "cpu" : await loadedOn();
        return { ok: true, detail: `ollama @ ${baseUrl}${where ? ` (${where})` : ""}`, device: where };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
