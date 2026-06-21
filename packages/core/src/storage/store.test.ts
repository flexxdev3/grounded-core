import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defaultConfig } from "../config.js";
import { openStore } from "../store.js";
import type { GroundedConfig, Store } from "../contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(__dirname, "../../../../examples/docs");

function sqliteConfig(home: string): GroundedConfig {
  const cfg = defaultConfig(home);
  cfg.storage.adapter = "sqlite";
  cfg.storage.path = join(home, "grounded.db");
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 0;
  return cfg;
}

describe("Store lifecycle (sqlite, embeddings=none)", () => {
  let home: string;
  let store: Store;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-test-"));
    store = await openStore(sqliteConfig(home));
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("init + health reports lexical-only", async () => {
    const h = await store.health();
    expect(h.ok).toBe(true);
    expect(h.storage.adapter).toBe("sqlite");
    expect(h.embeddings.provider).toBe("none");
    expect(h.embeddings.dims).toBe(0);
  });

  it("facts: add / get / list / supersede / delete", async () => {
    const f = await store.factsAdd({
      fact: "never push to GitHub without explicit instruction",
      detail: "gh is authed to a public account",
      category: "commit-rule",
      pinned: true,
      importance: 1,
      topicKey: "no-push",
    });
    expect(f.id).toBeGreaterThan(0);
    expect(f.pinned).toBe(true);

    const got = await store.factsGet(f.id);
    expect(got?.fact).toBe(f.fact);

    const list = await store.factsList({ status: "active" });
    expect(list.some((x) => x.id === f.id)).toBe(true);

    const replacement = await store.factsSupersede(f.id, {
      fact: "never push to any remote without explicit instruction",
      pinned: true,
      importance: 1,
    });
    expect(replacement.id).not.toBe(f.id);
    const oldFact = await store.factsGet(f.id);
    expect(oldFact?.status).toBe("superseded");
    expect(oldFact?.supersededBy).toBe(replacement.id);

    const deleted = await store.factsDelete(replacement.id);
    expect(deleted).toBe(true);
    expect(await store.factsGet(replacement.id)).toBeNull();
  });

  it("sessions: add / list / timeline", async () => {
    const s1 = await store.sessionsAdd({
      summary: "built the sqlite adapter for grounded recall",
      details: "implemented hybrid recall with RRF fusion",
      project: "grounded",
    });
    const s2 = await store.sessionsAdd({
      summary: "wrote the embedding providers",
      project: "grounded",
    });
    expect(s1.id).toBeGreaterThan(0);

    const list = await store.sessionsList({ project: "grounded" });
    expect(list.length).toBeGreaterThanOrEqual(2);
    // newest first
    expect(list[0]!.id).toBe(s2.id);

    const tl = await store.sessionsTimeline({ around: s1.id, window: 2 });
    expect(tl.some((x) => x.id === s1.id)).toBe(true);

    const byQuery = await store.sessionsTimeline({ query: "embedding providers" });
    expect(byQuery.some((x) => x.id === s2.id)).toBe(true);
  });

  it("docs: ingest the examples folder, strips <private>", async () => {
    const report = await store.docsIngest([EXAMPLES], { source: "examples" });
    expect(report.scanned).toBeGreaterThan(0);
    expect(report.added).toBeGreaterThan(0);

    const docs = await store.docsList();
    expect(docs.length).toBeGreaterThan(0);
    const allBodies = docs.map((d) => d.body).join("\n");
    expect(allBodies).not.toMatch(/should be stripped/i);
    expect(allBodies).not.toMatch(/<private>/i);

    // idempotent re-ingest
    const again = await store.docsIngest([EXAMPLES], { source: "examples" });
    expect(again.added).toBe(0);
    expect(again.skipped).toBeGreaterThan(0);
  });

  it("recall: lexical-only returns cited cards, facts before docs, no private", async () => {
    await store.factsAdd({
      fact: "recall fuses vector and lexical lanes with RRF",
      category: "recall",
      importance: 0.5,
    });
    const results = await store.recall("recall lexical vector fusion");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.citation).toBeTruthy();
      expect(r.typedId).toMatch(/^(fact|session|doc):\d+$/);
      expect(r.matchedBy).toBe("lexical");
      expect(r.snippet).not.toMatch(/should be stripped/i);
    }
    // facts tier comes before docs tier
    const firstDoc = results.findIndex((r) => r.sourceType === "doc");
    const firstFact = results.findIndex((r) => r.sourceType === "fact");
    if (firstDoc >= 0 && firstFact >= 0) {
      expect(firstFact).toBeLessThan(firstDoc);
    }
  });

  it("get(typedId) returns full records", async () => {
    const results = await store.recall("recall fusion");
    expect(results.length).toBeGreaterThan(0);
    const first = results[0]!;
    const full = await store.get(first.typedId);
    expect(full).not.toBeNull();
    expect(full!.sourceType).toBe(first.sourceType);
  });

  it("brief: assembles startup context markdown", async () => {
    const brief = await store.brief({
      project: "grounded",
      query: "recall",
      format: "markdown",
    });
    expect(brief.startupNote).toBeTruthy();
    expect(brief.text).toContain("=== STARTUP CONTEXT ===");
    expect(brief.text).toContain("=== MOST RECENT WORK");
    expect(brief.text).toContain("=== FACTS BRAIN");
    expect(brief.recentSessions.length).toBeGreaterThan(0);
  });

  it("brief: json format omits text", async () => {
    const brief = await store.brief({ format: "json" });
    expect(brief.text).toBeUndefined();
  });

  it("docsPrune marks missing nothing when files present", async () => {
    const res = await store.docsPrune();
    expect(res.missing).toBe(0);
  });
});
