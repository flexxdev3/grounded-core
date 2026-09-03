import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import type {
  Fact,
  GroundedConfig,
  RecallResult,
  Session,
  Store,
  TypedId,
  Vision,
} from "../contract.js";
import { openStore } from "../store.js";
import {
  applyCategoryFloors,
  assembleBrief,
  dedupeDocsByPath,
  fillRelatedDocs,
  RELATED_DOCS_FETCH,
  RELATED_DOCS_LIMIT,
} from "./brief.js";

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

function makeSession(overrides: Partial<Session> & { id: number }): Session {
  return {
    summary: `session ${overrides.id}`,
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
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

// The brief's session line carries a DATE ONLY. Rendered from a UTC instant with
// no zone, a caller west of UTC reads their own local-evening work as tomorrow —
// which silently misdates every "what did we do yesterday" judgement made off a
// brief. This was live: a session logged 2026-07-26 23:53 CDT rendered "2026-07-27".
describe("assembleBrief: session dates render in the caller's timezone", () => {
  const eveningInChicago = "2026-07-27T04:53:02.290Z"; // = 2026-07-26 23:53 CDT

  const parts = {
    recentSessions: [
      makeSession({ id: 470, summary: "imagegen light-table shipped", createdAt: eveningInChicago }),
    ],
    facts: [],
    relatedDocs: [],
    factsAvailable: 0,
    recentSessionsAvailable: 1,
  };

  it("without a timezone, stays UTC — byte-identical to the pre-option behavior", () => {
    const brief = assembleBrief(parts, { format: "markdown" as const }, defaultConfig());
    expect(brief.text).toContain("- 2026-07-27");
    expect(brief.text).toContain("=== MOST RECENT WORK (newest first) ===");
  });

  it("with a timezone, renders the caller's local DAY, not UTC's", () => {
    const brief = assembleBrief(
      parts,
      { format: "markdown" as const, timezone: "America/Chicago" },
      defaultConfig(),
    );
    expect(brief.text).toContain("- 2026-07-26");
    expect(brief.text).not.toContain("- 2026-07-27");
  });

  it("names the zone in the header, so a non-UTC date is never ambiguous", () => {
    const brief = assembleBrief(
      parts,
      { format: "markdown" as const, timezone: "America/Chicago" },
      defaultConfig(),
    );
    expect(brief.text).toContain("=== MOST RECENT WORK (newest first · America/Chicago) ===");
  });

  it("shifts the other way east of UTC", () => {
    // A DIFFERENT instant from the one above: 20:00Z is still the 26th in UTC but
    // already the 27th in Auckland (+12). Reusing 04:53Z here would have "passed"
    // while proving nothing, since Auckland and UTC agree on that date.
    const eastParts = {
      ...parts,
      recentSessions: [makeSession({ id: 471, createdAt: "2026-07-26T20:00:00.000Z" })],
    };
    const utc = assembleBrief(eastParts, { format: "markdown" as const }, defaultConfig());
    expect(utc.text).toContain("- 2026-07-26");

    const nz = assembleBrief(
      eastParts,
      { format: "markdown" as const, timezone: "Pacific/Auckland" },
      defaultConfig(),
    );
    expect(nz.text).toContain("- 2026-07-27");
  });

  it("leaves the JSON createdAt as UTC ISO — this is a display option only", () => {
    const brief = assembleBrief(
      parts,
      { format: "json" as const, timezone: "America/Chicago" },
      defaultConfig(),
    );
    expect(brief.recentSessions[0]!.createdAt).toBe(eveningInChicago);
  });

  it("falls back to the UTC slice rather than throwing on an unknown zone", () => {
    // The API rejects a bad zone with a 400; the engine must still never fail a
    // whole brief assembly over one unrenderable date.
    const brief = assembleBrief(
      parts,
      { format: "markdown" as const, timezone: "America/Nowhere" },
      defaultConfig(),
    );
    expect(brief.text).toContain("- 2026-07-27");
  });
});

// ---------------------------------------------------------------------------
// The accounting contract (see the block comment in brief.ts): a lane that
// reports `truncated: true` must account for what it withheld. Reported live
// against the homelab instance as `sessions {returned: 8, available: 50,
// truncated: true}` with `droppedItems: []` — 42 sessions withheld, none named,
// and the rendered brief said nothing at all about them.
// ---------------------------------------------------------------------------
describe("assembleBrief: a truncated lane accounts for what it withheld", () => {
  // Long enough that ~14 lines saturate the 500-tok (2000-char) sessions
  // reserve, so the char budget is genuinely reachable in these fixtures.
  const longSummary =
    "reworked the reserve accounting so every withheld row is either named by id or counted";
  const manySessions = (n: number): Session[] =>
    Array.from({ length: n }, (_, i) => makeSession({ id: i + 1, summary: longSummary, project: "grounded" }));

  it("names every session the row cap cut, by typed id — dropped === available - returned", () => {
    const sessions = manySessions(50);
    const brief = assembleBrief(
      {
        recentSessions: sessions,
        facts: [],
        relatedDocs: [],
        factsAvailable: 0,
        recentSessionsAvailable: 50,
      },
      { format: "json" as const },
      defaultConfig(),
    );

    expect(brief.meta.sessions.truncated).toBe(true);
    expect(brief.meta.sessions.available).toBe(50);
    expect(brief.meta.sessions.returned).toBe(8); // DEFAULT_RECENT_SESSIONS
    // The whole point: nothing is withheld without being named.
    expect(brief.droppedItems).toHaveLength(
      brief.meta.sessions.available - brief.meta.sessions.returned,
    );
    expect(brief.droppedItems.every((id) => id.startsWith("session:"))).toBe(true);
    // In order, starting at the first row past the cap — never cherry-picked.
    expect(brief.droppedItems[0]).toBe("session:9");
    expect(brief.droppedItems.at(-1)).toBe("session:50");
  });

  it("names every session the CHAR reserve cut when the row cap is lifted", () => {
    const sessions = manySessions(50);
    const brief = assembleBrief(
      {
        recentSessions: sessions,
        facts: [],
        relatedDocs: [],
        factsAvailable: 0,
        recentSessionsAvailable: 50,
      },
      { format: "json" as const, recentSessions: 100 },
      defaultConfig(),
    );

    // The reserve, not the cap, is now the binding constraint.
    expect(brief.meta.sessions.returned).toBeGreaterThan(8);
    expect(brief.meta.sessions.returned).toBeLessThan(50);
    expect(brief.droppedItems).toHaveLength(
      brief.meta.sessions.available - brief.meta.sessions.returned,
    );
    expect(brief.droppedItems.every((id) => id.startsWith("session:"))).toBe(true);
  });

  it("the markdown names the dropped session ids so they can be fetched", () => {
    const brief = assembleBrief(
      {
        recentSessions: manySessions(50),
        facts: [],
        relatedDocs: [],
        factsAvailable: 0,
        recentSessionsAvailable: 50,
      },
      { format: "markdown" as const },
      defaultConfig(),
    );
    expect(brief.text).toContain("42 more sessions in scope");
    expect(brief.text).toContain("ground_get any of: session:9");
  });

  // The live failure shape. The engine cannot invent ids for rows the adapter's
  // fetch window never handed it, so `droppedItems` stays empty here BY
  // CONSTRUCTION — but the brief must still not be silent about them.
  it("counts (and points at) sessions the caller's fetch window never handed it", () => {
    const brief = assembleBrief(
      {
        recentSessions: manySessions(8),
        facts: [],
        relatedDocs: [],
        factsAvailable: 0,
        recentSessionsAvailable: 50,
      },
      { format: "markdown" as const },
      defaultConfig(),
    );

    expect(brief.meta.sessions).toMatchObject({ returned: 8, available: 50, truncated: true });
    expect(brief.droppedItems).toEqual([]);
    expect(brief.text).toContain("42 more sessions in scope");
    expect(brief.text).toContain("not individually named");
    expect(brief.text).toContain("ground_timeline");
  });

  it("does not fire a note for an untruncated lane", () => {
    const brief = assembleBrief(
      {
        recentSessions: manySessions(3),
        facts: [],
        relatedDocs: [],
        factsAvailable: 0,
        recentSessionsAvailable: 3,
      },
      { format: "markdown" as const },
      defaultConfig(),
    );
    expect(brief.meta.sessions.truncated).toBe(false);
    expect(brief.text).not.toContain("more sessions in scope");
  });
});

describe("assembleBrief: facts index-tier rather than drop", () => {
  // Long enough that only a handful fit the 900-tok (3600-char) full-text
  // reserve, but whose index lines (`topicKey — detail (fact:NN)`) are cheap
  // enough that the entire overflow fits the 300-tok index tier.
  const bulky = (id: number): Fact =>
    makeFact({
      id,
      category: "homelab",
      fact: `fact ${id} ${"z".repeat(400)}`,
      topicKey: `topic-${id}`,
      detail: "when it matters",
    });

  it("overflow facts land in indexedItems, not droppedItems, and still render", () => {
    const facts = Array.from({ length: 20 }, (_, i) => bulky(i + 1));
    const brief = assembleBrief(
      {
        recentSessions: [],
        facts,
        relatedDocs: [],
        factsAvailable: facts.length,
        recentSessionsAvailable: 0,
      },
      { format: "markdown" as const },
      defaultConfig(),
    );

    expect(brief.indexedItems.length).toBeGreaterThan(0);
    expect(brief.meta.facts.indexed).toBe(brief.indexedItems.length);
    expect(brief.droppedItems.filter((id) => id.startsWith("fact:"))).toEqual([]);
    // Every fact is accounted for: rendered in full, or rendered compressed.
    expect(brief.facts.length + brief.indexedItems.length).toBe(facts.length);
    // ...and the index lines are really in the text, not just in the metadata.
    const indexedId = brief.indexedItems[0]!;
    expect(brief.text).toContain(indexedId);
  });

  // The index tier used to engage in total silence: compressed lines look like
  // ordinary (terse) fact lines, so a reader could not tell budget pressure
  // from brevity. Every lane that clips has to say what it clipped.
  it("labels the index block, naming the count and the way back to full text", () => {
    const facts = Array.from({ length: 20 }, (_, i) => bulky(i + 1));
    const brief = assembleBrief(
      {
        recentSessions: [],
        facts,
        relatedDocs: [],
        factsAvailable: facts.length,
        recentSessionsAvailable: 0,
      },
      { format: "markdown" as const },
      defaultConfig(),
    );
    expect(brief.indexedItems.length).toBeGreaterThan(1);
    expect(brief.text).toContain(
      `… ${brief.indexedItems.length} more facts compressed to index lines`,
    );
    expect(brief.text).toContain("ground_get for the full text");
    // The label sits directly above the compressed lines, never above the
    // full-text ones.
    const lines = brief.text!.split("\n");
    const labelAt = lines.findIndex((l) => l.includes("compressed to index lines"));
    expect(lines[labelAt + 1]).toContain(brief.indexedItems[0]!);
  });

  it("says nothing about compression when nothing was compressed", () => {
    const brief = assembleBrief(
      {
        recentSessions: [],
        facts: [makeFact({ id: 1, fact: "a terse fact" })],
        relatedDocs: [],
        factsAvailable: 1,
        recentSessionsAvailable: 0,
      },
      { format: "markdown" as const },
      defaultConfig(),
    );
    expect(brief.text).not.toContain("compressed to index lines");
  });

  it("keeps the pinned delivery guarantee even when the reserve is saturated", () => {
    const facts = [...Array.from({ length: 20 }, (_, i) => bulky(i + 1)), makeFact({
      id: 99,
      category: "homelab",
      fact: "never force-push main",
      pinned: true,
    })];
    const brief = assembleBrief(
      {
        recentSessions: [],
        facts,
        relatedDocs: [],
        factsAvailable: facts.length,
        recentSessionsAvailable: 0,
      },
      { format: "json" as const },
      defaultConfig(),
    );
    // Pinned is a delivery guarantee, not a rank boost: full text, last position.
    expect(brief.facts.some((f) => f.id === 99)).toBe(true);
    expect(brief.indexedItems).not.toContain("fact:99");
    expect(brief.droppedItems).not.toContain("fact:99");
  });
});

// Case 3 of the accounting contract. Vision has no arm in `SourceType`/
// `TypedId`, so it CANNOT appear in `droppedItems` — that exemption is
// deliberate and documented on `BriefResult.meta`. What it owes instead is
// `meta.vision.chars` plus a way back to the full record.
describe("assembleBrief: vision is exempt from droppedItems but not from accounting", () => {
  const makeVision = (scope: string, chars: number): Vision => ({
    id: scope === "global" ? 1 : 2,
    scope,
    summary: `${scope} vision `.padEnd(chars, "v"),
    details: "full narrative",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const parts = {
    // 1800 chars against the 400-tok (1600-char) vision reserve: the project
    // row is cut, but not all the way down to a bare ellipsis, so BOTH rows
    // still count as returned — vision truncates text, it does not drop rows.
    vision: { global: makeVision("global", 900), project: makeVision("project:grounded", 900) },
    recentSessions: [],
    facts: [],
    relatedDocs: [],
    factsAvailable: 0,
    recentSessionsAvailable: 0,
  };

  it("never puts vision in droppedItems, and reports the cut in meta.vision.chars", () => {
    const brief = assembleBrief(parts, { format: "json" as const }, defaultConfig());
    expect(brief.meta.vision.truncated).toBe(true);
    expect(brief.meta.vision.chars!.available).toBe(1800);
    expect(brief.meta.vision.chars!.returned).toBeLessThan(1800);
    // Rows, not chars — both vision rows survived; only their text was cut.
    expect(brief.meta.vision).toMatchObject({ returned: 2, available: 2 });
    expect(brief.droppedItems).toEqual([]);
    expect(brief.indexedItems).toEqual([]);
  });

  it("points a truncated vision at the tool that returns it in full", () => {
    const brief = assembleBrief(parts, { format: "markdown" as const }, defaultConfig());
    expect(brief.text).toContain("ground_vision_get");
    expect(brief.text).toContain("of 1800 chars");
  });

  it("says nothing about a CUT when the vision fit", () => {
    const brief = assembleBrief(
      { ...parts, vision: { global: makeVision("global", 200), project: null } },
      { format: "markdown" as const },
      defaultConfig(),
    );
    expect(brief.meta.vision.truncated).toBe(false);
    expect(brief.text).not.toContain("cut to");
  });

  // The clip account vision owes in place of `droppedItems`: per-ROW, named,
  // in the same meta shape the other lanes use.
  it("names each clipped row in meta.vision.rows instead of only summing chars", () => {
    const brief = assembleBrief(parts, { format: "json" as const }, defaultConfig());
    const rows = brief.meta.vision.rows!;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ref)).toEqual(["vision:1", "vision:2"]);
    expect(rows[0]!.scope).toBe("global");
    // The project row is the one the reserve cut (project truncates first).
    expect(rows[1]!.clipped).toBe(true);
    expect(rows[1]!.chars.returned).toBeLessThan(rows[1]!.chars.available);
  });
});

// The verified trap: a non-null `summary` REPLACES `details` in the brief, so
// setting a summary blanks the body at SessionStart. The behavior is asserted
// by the shared store suite and is deliberate (a lane budgeted for one of the
// two fields cannot carry both) — what it may not be is silent.
describe("assembleBrief: a summary that suppresses details says so, loudly", () => {
  const withSummary: Vision = {
    id: 7,
    scope: "project:grounded",
    summary: "one-line vision summary",
    details: "the full vision body that the summary replaces at SessionStart".repeat(3),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const noSummary: Vision = { ...withSummary, id: 8, summary: null };
  const parts = (v: Vision) => ({
    vision: { global: null, project: v },
    recentSessions: [],
    facts: [],
    relatedDocs: [],
    factsAvailable: 0,
    recentSessionsAvailable: 0,
  });

  it("accounts the suppressed details chars on the row", () => {
    const brief = assembleBrief(parts(withSummary), { format: "json" as const }, defaultConfig());
    const row = brief.meta.vision.rows![0]!;
    expect(row.ref).toBe("vision:7");
    expect(row.suppressedDetailChars).toBe(withSummary.details.length);
    // Not a text cut — the summary itself fit. Suppression is its own signal.
    expect(row.clipped).toBe(false);
    expect(brief.meta.vision.truncated).toBe(false);
  });

  it("renders a line naming the row and the chars the brief did not inject", () => {
    const brief = assembleBrief(
      parts(withSummary),
      { format: "markdown" as const },
      defaultConfig(),
    );
    expect(brief.text).toContain("one-line vision summary");
    expect(brief.text).not.toContain("the full vision body that the summary replaces");
    expect(brief.text).toContain("vision:7 (project:grounded) shows its summary");
    expect(brief.text).toContain(`${withSummary.details.length} chars of details were not injected`);
    expect(brief.text).toContain("ground_vision_get");
  });

  it("says nothing when there is no summary to suppress with", () => {
    const brief = assembleBrief(parts(noSummary), { format: "markdown" as const }, defaultConfig());
    expect(brief.text).not.toContain("shows its summary");
    expect(brief.meta.vision.rows![0]!.suppressedDetailChars).toBeUndefined();
  });
});

// relatedDocs is a fixed-slot lane, and recall ranks CHUNKS. Measured on the
// live brief: 5 slots held 3 unique files (claude/CLAUDE.md x2,
// how-tos/how-to-grounded-project-identity.md x2) — ~40% of the doc budget
// spent re-citing a file the reader already had.
describe("brief: relatedDocs holds one row per file", () => {
  let home: string;
  let store: Store;
  let docsDir: string;
  const TOKEN = "zzqdedupechunktoken";
  const FILES = 6;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-brief-dedupe-"));
    docsDir = join(home, "docs");
    mkdirSync(docsDir, { recursive: true });
    // Each file is many paragraphs long and mentions TOKEN throughout, so the
    // chunker splits it (config default chunkChars: 1200) and several chunks
    // of the SAME file are legitimate recall hits.
    for (let f = 0; f < FILES; f++) {
      const paras: string[] = [`# dedupe fixture ${f}`];
      for (let p = 0; p < 12; p++) {
        paras.push(
          `${TOKEN} paragraph ${p} of fixture ${f}. ` +
            `filler filler filler filler filler filler filler filler ${TOKEN} `.repeat(12),
        );
      }
      writeFileSync(join(docsDir, `fixture-${f}.md`), paras.join("\n\n"), "utf8");
    }

    const cfg: GroundedConfig = defaultConfig(home);
    cfg.storage.adapter = "sqlite";
    cfg.storage.path = join(home, "grounded.db");
    cfg.embeddings.provider = "none";
    cfg.embeddings.dims = 0;
    store = await openStore(cfg);
    await store.docsIngest([docsDir], { source: "dedupe-fixture" });
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the fixture really does produce multiple chunks per file (the cause)", async () => {
    // Guards the premise: without multi-chunk files the dedupe test proves
    // nothing. It used to read that premise off duplicate PATHS in recall's
    // output; recall now rolls chunks up per document, so the same premise is
    // read off the rollup count instead.
    const chunkHits = await store.recall(TOKEN, { sources: ["doc"], limit: RELATED_DOCS_FETCH });
    expect(chunkHits.data.length).toBeGreaterThan(RELATED_DOCS_LIMIT);
    expect(chunkHits.data.some((d) => (d.chunks ?? 1) > 1)).toBe(true);
  });

  it("contains each path at most once, keeping that path's best chunk", async () => {
    const brief = await store.brief({ query: TOKEN, format: "json" });

    const paths = brief.relatedDocs.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);

    // The surviving row for each path must be the highest-scoring chunk of
    // that file. 200 is the widest fetch the lane can escalate to, so this
    // covers every row the brief could possibly have seen.
    const fetched = (await store.recall(TOKEN, { sources: ["doc"], limit: 200 })).data;
    for (const kept of brief.relatedDocs) {
      const bestForPath = Math.max(
        ...fetched.filter((d) => d.path === kept.path).map((d) => d.score),
      );
      expect(kept.score).toBe(bestForPath);
    }
  });

  it("still fills all five slots when enough distinct files match", async () => {
    // The regression the dedupe must not introduce: shrinking the lane from
    // "5 slots, 3 files" to "3 slots" trades one budget waste for another.
    // This fixture is deliberately hostile — 6 near-identical long files, so
    // the first RELATED_DOCS_FETCH rows are all chunks of the same 2 files and
    // only the escalation in fillRelatedDocs can fill the lane.
    const brief = await store.brief({ query: TOKEN, format: "json" });
    expect(brief.relatedDocs.length).toBe(RELATED_DOCS_LIMIT);
    expect(new Set(brief.relatedDocs.map((d) => d.path)).size).toBe(RELATED_DOCS_LIMIT);
  });

  it("/recall now rolls chunks up per document too — the brief's dedupe is no longer the only place", async () => {
    // This assertion is INVERTED from what it used to say. It read "recall
    // still returns chunk-level duplicate paths" — the brief deduped, recall
    // did not. Recall now returns one row per DOCUMENT, so the duplicates it
    // guarded are gone; `dedupeDocsByPath` stays as the brief's own guarantee
    // (and its unit tests below still cover it directly).
    const res = await store.recall(TOKEN, { sources: ["doc"], limit: 5 });
    const paths = res.data.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
    // KNOWN TRADE-OFF, asserted rather than glossed: the rollup collapses
    // chunks INSIDE the candidate pool, and this fixture is deliberately
    // hostile — 6 near-identical long files, so the laneN (max(limit*3,20))
    // candidates are all chunks of the same 2 files and the answer legitimately
    // under-fills `limit`. `truncated` says so. Recall does not escalate its
    // fetch; `fillRelatedDocs` does, which is why the brief still fills all
    // five slots on this same fixture (the test above).
    expect(res.data.length).toBeLessThanOrEqual(5);
    expect(res.data.length).toBeGreaterThan(0);
    if (res.data.length < 5) expect(res.meta.truncated).toBe(true);
  });
});

describe("dedupeDocsByPath", () => {
  function hit(id: number, path: string | null, score: number): RecallResult {
    return {
      sourceType: "doc",
      id,
      typedId: `doc:${id}`,
      title: `doc ${id}`,
      score,
      matchedBy: "lexical",
      path,
      citation: `doc:${path ?? id}#chunk${id}`,
      snippet: `snippet ${id}`,
    };
  }

  it("keeps the highest-scoring chunk regardless of arrival order", () => {
    const out = dedupeDocsByPath([hit(1, "a.md", 0.2), hit(2, "a.md", 0.9), hit(3, "b.md", 0.5)]);
    expect(out.map((d) => d.typedId)).toEqual(["doc:2", "doc:3"]);
  });

  it("never folds two pathless rows into one", () => {
    const out = dedupeDocsByPath([hit(1, null, 0.9), hit(2, null, 0.8)]);
    expect(out.length).toBe(2);
  });

  it("caps at the lane's slot count", () => {
    const many = Array.from({ length: 12 }, (_, i) => hit(i, `f${i}.md`, 1 - i / 100));
    expect(dedupeDocsByPath(many).length).toBe(RELATED_DOCS_LIMIT);
  });
});

describe("fillRelatedDocs", () => {
  function hit(id: number, path: string, score: number): RecallResult {
    return {
      sourceType: "doc",
      id,
      typedId: `doc:${id}`,
      title: `doc ${id}`,
      score,
      matchedBy: "lexical",
      path,
      citation: `doc:${path}#chunk${id}`,
      snippet: `snippet ${id}`,
    };
  }

  it("does not widen when the first fetch already fills the lane", async () => {
    const asked: number[] = [];
    const out = await fillRelatedDocs(async (limit) => {
      asked.push(limit);
      return Array.from({ length: limit }, (_, i) => hit(i, `f${i}.md`, 1 - i / 100));
    });
    expect(asked).toEqual([RELATED_DOCS_FETCH]);
    expect(out.length).toBe(RELATED_DOCS_LIMIT);
  });

  it("widens once when the first fetch is saturated by too few files", async () => {
    const asked: number[] = [];
    const out = await fillRelatedDocs(async (limit) => {
      asked.push(limit);
      // Two files' worth of chunks until the ask gets wide enough to reach the rest.
      return Array.from({ length: limit }, (_, i) =>
        hit(i, `f${limit > RELATED_DOCS_FETCH ? i : i % 2}.md`, 1 - i / 1000),
      );
    });
    expect(asked.length).toBe(2);
    expect(asked[1]).toBeGreaterThan(RELATED_DOCS_FETCH);
    expect(out.length).toBe(RELATED_DOCS_LIMIT);
  });

  it("stops instead of widening when the lane is exhausted", async () => {
    const asked: number[] = [];
    const out = await fillRelatedDocs(async (limit) => {
      asked.push(limit);
      // Short read: fewer rows than requested means no wider ask can help.
      return [hit(1, "a.md", 0.9), hit(2, "a.md", 0.5), hit(3, "b.md", 0.4)];
    });
    expect(asked).toEqual([RELATED_DOCS_FETCH]);
    expect(out.map((d) => d.path)).toEqual(["a.md", "b.md"]);
  });
});
