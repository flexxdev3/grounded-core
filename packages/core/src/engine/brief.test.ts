import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import type { Fact, GroundedConfig, Session, Store, TypedId } from "../contract.js";
import { openStore } from "../store.js";
import { applyCategoryFloors, assembleBrief } from "./brief.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(__dirname, "../../../../examples/docs");

// POST /brief must not drop bodies — fact.detail and the related-doc snippet
// survive into the rendered markdown alongside their citations.
//
// Sessions are the deliberate exception: the brief renders `summary` only and
// leaves `details` behind `ground_get`. A session log is unbounded (8 of them
// cost ~7k tok, several times the whole startup budget), so inlining it in a
// budgeted lane would starve every other lane. fact.detail is a single short
// trigger and stays inline — short field inline, long field behind an id.
describe("brief: renders bodies, not just headings", () => {
  let home: string;
  let store: Store;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-brief-test-"));
    const cfg: GroundedConfig = defaultConfig(home);
    cfg.storage.adapter = "sqlite";
    cfg.storage.path = join(home, "grounded.db");
    cfg.embeddings.provider = "none";
    cfg.embeddings.dims = 0;
    store = await openStore(cfg);
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("markdown includes fact detail and a doc snippet; session details stay behind ground_get", async () => {
    await store.factsAdd({
      fact: "never push to any remote without explicit instruction",
      detail: "gh is authed to a public account, double-check before pushing",
      category: "commit-rule",
      importance: 1,
    });

    await store.sessionsAdd({
      summary: "wired up the brief renderer",
      details: "added whitespace-collapsed bodies for facts, sessions, and related docs",
      project: "grounded",
    });

    await store.docsIngest([EXAMPLES], { source: "examples" });
    const docs = (await store.docsList()).data;
    const seedDoc = docs[0]!;

    const brief = await store.brief({
      format: "markdown",
      project: "grounded",
      query: seedDoc.title ?? seedDoc.body.slice(0, 40),
    });

    expect(brief.text).toBeTruthy();
    const text = brief.text!;

    expect(text).toContain("gh is authed to a public account, double-check before pushing");
    expect(text).toMatch(/\(fact:\d+\)/);

    // The session's summary and citation are present...
    expect(text).toContain("wired up the brief renderer");
    expect(text).toMatch(/\(session:\d+\)/);
    // ...but its details are NOT inlined into the budgeted lane.
    expect(text).not.toContain(
      "added whitespace-collapsed bodies for facts, sessions, and related docs",
    );
    // They must still be one hop away, or this is data loss rather than
    // progressive disclosure. Resolve the cited id and assert the body is there.
    const citedId = /\((session:\d+)\)/.exec(text)?.[1] as TypedId;
    const full = await store.get(citedId);
    expect(full?.sourceType).toBe("session");
    expect((full?.record as Session).details).toContain(
      "added whitespace-collapsed bodies for facts, sessions, and related docs",
    );

    expect(brief.relatedDocs.length).toBeGreaterThan(0);
    const doc = brief.relatedDocs[0]!;
    expect(doc.snippet.trim().length).toBeGreaterThan(0);
    const collapsedSnippet = doc.snippet.replace(/\s+/g, " ").trim();
    expect(text).toContain(collapsedSnippet);
    expect(text).toContain(doc.citation);
  });
});

// applyCategoryFloors — the pre-pass that keeps a high-volume category from
// evicting every fact of a rarer but important one before the reserve cutoff.
function makeFact(overrides: Partial<Fact> & { id: number; category: string }): Fact {
  return {
    scope: "global",
    fact: `fact ${overrides.id}`,
    pinned: false,
    importance: 0.5,
    status: "active",
    origin: "stated",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyCategoryFloors", () => {
  it("lifts a low-ranked floored-category fact above higher-ranked unfloored facts", () => {
    const facts = [
      makeFact({ id: 1, category: "homelab" }),
      makeFact({ id: 2, category: "homelab" }),
      makeFact({ id: 3, category: "commit-rule" }), // ranked last, but floored
    ];
    const out = applyCategoryFloors(facts, { "commit-rule": 1 });
    expect(out.map((f) => f.id)).toEqual([3, 1, 2]);
  });

  it("output is a strict permutation of the input", () => {
    const facts = [
      makeFact({ id: 1, category: "a" }),
      makeFact({ id: 2, category: "b" }),
      makeFact({ id: 3, category: "a" }),
      makeFact({ id: 4, category: "c" }),
      makeFact({ id: 5, category: "b" }),
    ];
    const out = applyCategoryFloors(facts, { a: 1, c: 5 });
    expect(out).toHaveLength(facts.length);
    expect(new Set(out.map((f) => f.id))).toEqual(new Set(facts.map((f) => f.id)));
  });

  it("empty floors is identity and does not mutate the input", () => {
    const facts = [makeFact({ id: 1, category: "a" }), makeFact({ id: 2, category: "b" })];
    const snapshot = [...facts];
    const out = applyCategoryFloors(facts, {});
    expect(out).toEqual(facts);
    expect(out).not.toBe(facts);
    expect(facts).toEqual(snapshot);
  });

  it("a floor larger than the available count takes all of them without throwing", () => {
    const facts = [makeFact({ id: 1, category: "a" }), makeFact({ id: 2, category: "a" })];
    expect(() => applyCategoryFloors(facts, { a: 100 })).not.toThrow();
    const out = applyCategoryFloors(facts, { a: 100 });
    expect(out.map((f) => f.id)).toEqual([1, 2]);
  });

  it("a floored category absent from the input is a no-op", () => {
    const facts = [makeFact({ id: 1, category: "a" }), makeFact({ id: 2, category: "b" })];
    const out = applyCategoryFloors(facts, { "nonexistent-category": 3 });
    expect(out).toEqual(facts);
  });
});

describe("assembleBrief: category floors fix the eviction bug end-to-end", () => {
  it("default floors keep the commit-rule fact; empty floors drop it", () => {
    // 8 `homelab` facts consume the entire facts reserve, plus one
    // `commit-rule` fact ranked last (as the live homelab category often
    // outnumbers rarer, higher-stakes categories in raw count).
    const longDetail = "x".repeat(440);
    const homelabFacts: Fact[] = Array.from({ length: 8 }, (_, i) =>
      makeFact({ id: i + 1, category: "homelab", fact: `homelab fact ${i + 1}`, detail: longDetail }),
    );
    const commitRuleFact = makeFact({
      id: 99,
      category: "commit-rule",
      fact: "never force-push main",
      detail: "y".repeat(60),
    });
    const facts = [...homelabFacts, commitRuleFact];

    const parts = {
      recentSessions: [],
      facts,
      relatedDocs: [],
      factsAvailable: facts.length,
      recentSessionsAvailable: 0,
    };
    const opts = { project: "grounded", format: "json" as const };

    const cfgWithFloors = defaultConfig();
    const withFloors = assembleBrief(parts, opts, cfgWithFloors);
    expect(withFloors.facts.some((f) => f.id === 99)).toBe(true);

    const cfgNoFloors: GroundedConfig = { ...cfgWithFloors, brief: { ...cfgWithFloors.brief, factCategoryFloors: {} } };
    const withoutFloors = assembleBrief(parts, opts, cfgNoFloors);
    expect(withoutFloors.facts.some((f) => f.id === 99)).toBe(false);
  });
});
