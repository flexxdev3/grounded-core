import pg from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { defaultConfig } from "../config.js";
import { openStore } from "../store.js";
import type { GroundedConfig, Store } from "../contract.js";

const PG_URL = process.env.GROUNDED_TEST_PG_URL;
const OLLAMA_BASE_URL = "http://192.168.1.217:11434";

// Hardcoded, never sourced from env or config — the only thing standing between
// the DROP below and the live `grounded` schema in the same database. Distinct
// from postgres.test.ts's `grounded_test` so the two suites can never collide
// if ever run concurrently.
const SCHEMA = "grounded_vec_test";

/** Cheap liveness probe: gate the whole suite on ollama actually answering,
 * not just being configured — a developer with no ollama running must never
 * see a hard failure here, only a skip. */
async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const pgUrlPresent = !!PG_URL;

function vecConfig(): GroundedConfig {
  const cfg = defaultConfig("/tmp/grounded-pg-vec-test");
  cfg.storage.adapter = "postgres";
  cfg.storage.url = PG_URL;
  cfg.storage.schema = SCHEMA;
  cfg.embeddings.provider = "ollama";
  cfg.embeddings.baseUrl = OLLAMA_BASE_URL;
  cfg.embeddings.model = "nomic-embed-text";
  cfg.embeddings.dims = 768;
  return cfg;
}

const d = pgUrlPresent ? describe : describe.skip;

d("postgres vector lane (real ollama embeddings) — recall fusion + bySource accounting", () => {
  let store: Store;
  let skipAll = false;

  beforeAll(async () => {
    if (!pgUrlPresent) return; // describe.skip already applies; belt & suspenders.
    const ollamaUp = await ollamaReachable();
    if (!ollamaUp) {
      skipAll = true;
      return;
    }
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(`drop schema if exists "${SCHEMA}" cascade`);
    } finally {
      await client.end();
    }
    store = await openStore(vecConfig());
  }, 30_000);

  afterAll(async () => {
    if (skipAll || !store) return;
    await store.close();
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(`drop schema if exists "${SCHEMA}" cascade`);
    } finally {
      await client.end();
    }
  }, 30_000);

  it("health reports the ollama provider live with the configured dims", async () => {
    if (skipAll) return;
    const h = await store.health();
    expect(h.embeddings.provider).toBe("ollama:nomic-embed-text");
    expect(h.embeddings.dims).toBe(768);
    expect(h.embeddings.ok).toBe(true);
  });

  it("recall over a semantically-related (not lexically-identical) query surfaces vector or fused hits", async () => {
    if (skipAll) return;
    // Phrasing deliberately avoids the literal tokens in the fact text, so a
    // pure-lexical (FTS-only) implementation would find nothing here — only
    // the ANN vector lane can bridge this. If this proves flaky by the model
    // in practice, it still asserts the union in-scope match count is honest,
    // which is the accounting behavior this file exists to exercise.
    const f = await store.factsAdd({
      fact: "reciprocal rank fusion blends cosine similarity and BM25 lexical scores",
      category: "recall-vector-lane-test",
      importance: 0.7,
    });

    try {
      const results = await store.recall("how do hybrid search engines combine semantic and keyword ranking", {
        sources: ["fact"],
        limit: 5,
      });

      expect(results.data.length).toBeGreaterThan(0);
      const hit = results.data.find((r) => r.id === f.id);
      expect(hit).toBeDefined();
      // Proves the ANN path actually ran — not just FTS falling back to a
      // lexical match on overlapping words like "rank"/"fusion".
      expect(["vector", "both"]).toContain(hit!.matchedBy);
    } finally {
      await store.factsDelete(f.id);
    }
  }, 20_000);

  it("RRF fuses vector and lexical lanes: a fact matched by both scores at least as high as either lane alone", async () => {
    if (skipAll) return;
    const uniqueToken = "zzqpgvecfusiontoken";
    const bothLanes = await store.factsAdd({
      fact: `${uniqueToken} hybrid recall combines vector embeddings with lexical full text search`,
      category: "recall-vector-lane-test",
      importance: 0.5,
    });
    // A lexical-only decoy: shares the unique token (so FTS ranks it) but is
    // semantically unrelated to the query used below, so vector shouldn't
    // rank it highly.
    const lexOnly = await store.factsAdd({
      fact: `${uniqueToken} unrelated grocery list for the weekend farmers market`,
      category: "recall-vector-lane-test",
      importance: 0.5,
    });

    try {
      // `or` is deliberate. The lexical lane runs `websearch_to_tsquery`, which
      // ANDs bare words — so any query phrased to pull the *related* fact via
      // vector similarity necessarily contains words the decoy lacks, and the
      // decoy silently drops out of the lexical lane entirely. That is exactly
      // how the earlier version of this test ended up asserting fusion while
      // measuring a pure vector hit. `<token> or <semantic terms>` parses to
      // `token | (hybrid & recall & vector & embeddings)`: the decoy matches
      // the token branch, the related fact matches both branches *and* the
      // vector lane. Only then is there anything to fuse.
      const results = await store.recall(`${uniqueToken} or hybrid recall with vector embeddings`, {
        sources: ["fact"],
        limit: 10,
      });

      const bothIdx = results.data.findIndex((r) => r.id === bothLanes.id);
      const lexIdx = results.data.findIndex((r) => r.id === lexOnly.id);
      expect(bothIdx).toBeGreaterThanOrEqual(0);
      expect(lexIdx).toBeGreaterThanOrEqual(0);
      const both = results.data[bothIdx]!;
      const lex = results.data[lexIdx]!;

      // Both lanes actually fired for the related fact. This is the assertion
      // the old `toContain(["vector","both","lexical"])` could not make: that
      // list was the entire domain of `matchedBy`, so it could never fail.
      expect(both.matchedBy).toBe("both");

      // The claim in this test's name, now actually asserted. RRF sums
      // 1/(k+rank) over the lanes an item appears in, so a two-lane hit
      // outscores a one-lane hit even when the one-lane hit tops its own lane.
      // Asserted as ORDER + strict score rather than via the decoy's
      // `matchedBy`: on a near-empty schema the ANN lane returns its top-N
      // regardless of distance, so the decoy may legitimately show up in the
      // vector lane too. What must never happen is the semantically unrelated
      // row ranking at or above the related one.
      expect(bothIdx).toBeLessThan(lexIdx);
      expect(both.score).toBeGreaterThan(lex.score);
    } finally {
      // Unconditional: a thrown assertion used to leak these two rows into the
      // next test, where the ANN lane counted them and turned one real failure
      // into two.
      await store.factsDelete(bothLanes.id);
      await store.factsDelete(lexOnly.id);
    }
  }, 20_000);

  it("bySource accounting under real embeddings: available is a real count, truncated flips when a lane saturates", async () => {
    if (skipAll) return;
    const uniqueToken = "zzqpgvecbysourcetoken";
    const ids: number[] = [];
    // 15 > default sourceCaps.fact (10), well under laneN (30 at the default
    // limit of 10) — this saturates the fuse-cap, not the lane-candidate
    // floor, so `available` must reflect the true 15, not the capped 10.
    for (let i = 0; i < 15; i++) {
      const f = await store.factsAdd({
        fact: `${uniqueToken} candidate ${i} about hybrid vector and lexical recall fusion`,
        category: "recall-vector-lane-test",
        importance: 0.5,
      });
      ids.push(f.id);
    }

    try {
      const result = await store.recall(uniqueToken, { sources: ["fact"] });
      const factMeta = result.meta.bySource?.fact;
      expect(factMeta).toBeDefined();
      expect(typeof factMeta!.available).toBe("number");
      // Exact, not >=. On a schema this small the ANN lane returns its top-N
      // regardless of distance, so any row an earlier test failed to clean up
      // lands in this count — which is precisely how a leak here shows up.
      expect(factMeta!.available).toBe(15);
      expect(factMeta!.returned).toBeLessThanOrEqual(10);
      expect(factMeta!.truncated).toBe(true);
    } finally {
      for (const id of ids) await store.factsDelete(id);
    }
  }, 30_000);
});
