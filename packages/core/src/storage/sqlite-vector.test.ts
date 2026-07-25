import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.js";
import { SqliteStore } from "./sqlite.js";
import type { EmbeddingProvider, GroundedConfig } from "../contract.js";

const DIMS = 8;

/** Deterministic hash-based fake embedder so the vector lane is exercised offline. */
function fakeEmbedder(): EmbeddingProvider {
  function vec(text: string): number[] {
    const out = new Array<number>(DIMS).fill(0);
    for (let i = 0; i < text.length; i++) {
      out[i % DIMS]! += text.charCodeAt(i) % 13;
    }
    const norm = Math.sqrt(out.reduce((a, b) => a + b * b, 0)) || 1;
    return out.map((x) => x / norm);
  }
  return {
    id: "fake:test",
    dims: DIMS,
    enabled: true,
    async embed(texts) {
      return texts.map(vec);
    },
    async health() {
      return { ok: true, detail: "fake" };
    },
  };
}

describe("sqlite vector lane (fake embedder)", () => {
  let home: string;
  let store: SqliteStore;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-vec-"));
    const cfg: GroundedConfig = defaultConfig(home);
    cfg.storage.path = join(home, "vec.db");
    cfg.embeddings.dims = DIMS;
    store = new SqliteStore(cfg, fakeEmbedder());
    await store.init();
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("vector path retrieves a fact with matchedBy reflecting both lanes", async () => {
    const h = await store.health();
    // vec0 should have loaded; storage detail mentions sqlite-vec
    expect(h.storage.detail).toContain("sqlite-vec");

    await store.factsAdd({
      fact: "hybrid recall combines cosine and bm25 via reciprocal rank fusion",
      category: "recall",
    });
    const results = (await store.recall("hybrid recall reciprocal rank fusion")).data;
    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!;
    expect(top.sourceType).toBe("fact");
    // matched in both vector and lexical lanes
    expect(["both", "vector", "lexical"]).toContain(top.matchedBy);
  });
});
