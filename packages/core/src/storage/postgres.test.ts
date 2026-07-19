import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defaultConfig } from "../config.js";
import { openStore } from "../store.js";
import type { GroundedConfig, Store } from "../contract.js";

const PG_URL = process.env.GROUNDED_TEST_PG_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(__dirname, "../../../../examples/docs");

function pgConfig(): GroundedConfig {
  const cfg = defaultConfig("/tmp/grounded-pg-test");
  cfg.storage.adapter = "postgres";
  cfg.storage.url = PG_URL;
  cfg.storage.schema = "grounded_test";
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 768;
  return cfg;
}

const suite = PG_URL ? describe : describe.skip;

suite("Store lifecycle (postgres, embeddings=none)", () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore(pgConfig());
  });

  afterAll(async () => {
    if (store) await store.close();
  });

  it("facts + sessions + docs + recall + brief round-trip", async () => {
    const f = await store.factsAdd({
      fact: "postgres adapter mirrors the live recall RPCs",
      category: "recall",
      pinned: true,
      importance: 1,
    });
    expect(f.id).toBeGreaterThan(0);

    await store.sessionsAdd({
      summary: "ported recall to pgvector + tsvector",
      project: "grounded",
    });

    const report = await store.docsIngest([EXAMPLES], { source: "examples" });
    expect(report.scanned).toBeGreaterThan(0);

    const results = await store.recall("recall fusion vector lexical");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.snippet).not.toMatch(/should be stripped/i);
    }

    const brief = await store.brief({ project: "grounded", format: "markdown" });
    expect(brief.text).toContain("=== STARTUP CONTEXT ===");

    const h = await store.health();
    expect(h.storage.adapter).toBe("postgres");
  });

  it("vision: one record per scope, edited in place + brief renders VISION", async () => {
    const v1 = await store.visionSet({ content: "first direction" });
    const v2 = await store.visionSet({ content: "second direction" });
    expect(v2.id).toBe(v1.id);
    expect(v2.content).toBe("second direction");
    const list = await store.visionList({ scope: "global" });
    expect(list.length).toBe(1);

    const brief = await store.brief({ format: "markdown" });
    expect(brief.text).toContain("=== VISION (global) ===");
    expect(brief.text).toContain("second direction");
    expect(brief.text).toContain("Apply this:");
  });
});
