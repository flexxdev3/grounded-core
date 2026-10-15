import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.js";
import { createEmbeddingProvider } from "./index.js";
import { localModelDir } from "./local.js";

describe("local provider", () => {
  const home = mkdtempSync(join(tmpdir(), "grounded-local-"));
  const cfg = defaultConfig(home);
  cfg.embeddings = { provider: "local" };

  it("is selected by provider = local, 768 dims, nomic by default", () => {
    const p = createEmbeddingProvider(cfg);
    expect(p.id).toBe("local:nomic-ai/nomic-embed-text-v1.5");
    expect(p.dims).toBe(768);
    expect(p.enabled).toBe(true);
  });

  it("maps the default config's ollama model name to the nomic repo", () => {
    const fromDefaults = defaultConfig(home);
    fromDefaults.embeddings.provider = "local";
    expect(createEmbeddingProvider(fromDefaults).id).toBe("local:nomic-ai/nomic-embed-text-v1.5");
  });

  it("keeps models under the cabinet", () => {
    expect(localModelDir(cfg, "nomic-ai/nomic-embed-text-v1.5")).toBe(
      join(home, "models", "nomic-ai--nomic-embed-text-v1.5"),
    );
  });

  it("health says the model downloads on first use, without downloading", async () => {
    const h = await createEmbeddingProvider(cfg).health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain("downloads on first use");
  });

  it.skipIf(!process.env.GROUNDED_TEST_LOCAL_EMBED)("embeds lowercased-equivalent text identically", async () => {
    const p = createEmbeddingProvider(cfg);
    const [a, b] = await p.embed(["SQLite adapter", "sqlite adapter"]);
    expect(a).toHaveLength(768);
    expect(a).toEqual(b); // nomic's tokenizer is uncased
  }, 300_000);
});
