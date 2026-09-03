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

  it("the vector lane embeds the query case-folded — 'Sentient Charts' ranks like 'sentient charts'", async () => {
    await store.factsAdd({ fact: "sentient charts render the signal stack in the dashboard", category: "sentient" });
    const lower = (await store.recall("sentient charts")).data;
    const mixed = (await store.recall("Sentient Charts")).data;
    const upper = (await store.recall("SENTIENT CHARTS")).data;
    expect(mixed.map((r) => [r.typedId, r.score])).toEqual(lower.map((r) => [r.typedId, r.score]));
    expect(upper.map((r) => [r.typedId, r.score])).toEqual(lower.map((r) => [r.typedId, r.score]));
    expect(lower[0]?.matchedBy).toBe("both");
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
    // Single-source store (facts only, no sessions or docs seeded), so the flat
    // score ranking cannot put anything else on top — this asserts the vector
    // path fired, not a source ordering.
    expect(top.sourceType).toBe("fact");
    // matched in both vector and lexical lanes
    expect(["both", "vector", "lexical"]).toContain(top.matchedBy);
  });

  it("vec_facts is scope-filtered by the over-fetch + post-filter path, not just the lexical lane", async () => {
    // The lexical lane would MASK a broken vector filter: a query whose terms
    // match no fact row leaves the fact lane vector-only, so an out-of-scope
    // row that survives here can only have come through vec_facts.
    const foreign = await store.factsAdd({
      fact: "zzqvecscope a rule belonging to some other project entirely",
      scope: "project:zzqforeign",
    });
    const mine = await store.factsAdd({
      fact: "zzqvecscope a rule belonging to the declared project",
      scope: "project:zzqmine",
    });
    try {
      // no lexical anchor at all — pure ANN over vec_facts
      const res = await store.recall("qqzz unmatchable gibberish token", {
        sources: ["fact"],
        project: "zzqmine",
        limit: 10,
      });
      expect(res.meta.lexical?.mode).toBe("none");
      expect(res.meta.lexical?.vectorOnly).toBe(true);
      const ids = res.data.map((r) => r.id);
      expect(ids).not.toContain(foreign.id);
      expect(ids).toContain(mine.id);
      expect(res.meta.scopeFilter?.appliedTo).toContain("fact");

      // ...and with nothing declared the same vector lane returns both.
      const open = await store.recall("qqzz unmatchable gibberish token", {
        sources: ["fact"],
        limit: 10,
      });
      const openIds = open.data.map((r) => r.id);
      expect(openIds).toContain(foreign.id);
      expect(openIds).toContain(mine.id);
    } finally {
      await store.factsDelete(foreign.id);
      await store.factsDelete(mine.id);
    }
  });
});
