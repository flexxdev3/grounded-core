import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config.js";
import {
  rrf,
  fuseLane,
  recencyMultiplier,
  orderResults,
  rankFlat,
  effectiveSourceCaps,
  withEffectiveSourceCaps,
  type CandidateMeta,
  type FusedItem,
} from "./recall.js";

describe("rrf", () => {
  it("decreases with rank", () => {
    expect(rrf(60, 0)).toBeGreaterThan(rrf(60, 1));
    expect(rrf(60, 0)).toBeCloseTo(1 / 60);
    expect(rrf(60, 5)).toBeCloseTo(1 / 65);
  });
});

describe("fuseLane", () => {
  const cfg = defaultConfig("/tmp/x");

  it("marks items in both lanes as matchedBy=both with summed score", () => {
    const vec = [{ id: 1, rank: 0 }];
    const lex = [{ id: 1, rank: 0 }];
    const meta = new Map<number, CandidateMeta>([
      [1, { sourceType: "doc", id: 1, active: true }],
    ]);
    const out = fuseLane("doc", vec, lex, meta, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]!.matchedBy).toBe("both");
    // two rrf(60,0) contributions, × activeStatus boost
    expect(out[0]!.score).toBeCloseTo((2 / 60) * cfg.recall.boosts.activeStatus);
  });

  it("applies pinned + importance boosts to facts", () => {
    const meta = new Map<number, CandidateMeta>([
      [1, { sourceType: "fact", id: 1, pinned: true, importance: 1 }],
      [2, { sourceType: "fact", id: 2, pinned: false, importance: 0 }],
    ]);
    const vec = [
      { id: 1, rank: 0 },
      { id: 2, rank: 0 },
    ];
    const out = fuseLane("fact", vec, [], meta, cfg);
    const f1 = out.find((o) => o.id === 1)!;
    const f2 = out.find((o) => o.id === 2)!;
    // f1 boosted by pinned(1.5) * (1 + 1*1) = 3x
    expect(f1.score).toBeGreaterThan(f2.score);
    expect(f1.score).toBeCloseTo((1 / 60) * 1.5 * 2);
  });

  // NOTE (effective-cap change): fuseLane still honours whatever cap the
  // config it is handed carries — this test is unchanged and still guards
  // that. What changed is upstream: recall() no longer hands fuseLane the raw
  // config, it hands `withEffectiveSourceCaps(cfg, limit)`, so the cap can
  // never sit below the caller's total limit. impact() still hands its own
  // stricter `= limit` clone. See effectiveSourceCaps' doc comment.
  it("respects source caps", () => {
    const small = defaultConfig("/tmp/x");
    small.recall.sourceCaps.doc = 1;
    const meta = new Map<number, CandidateMeta>([
      [1, { sourceType: "doc", id: 1, active: true }],
      [2, { sourceType: "doc", id: 2, active: true }],
    ]);
    const out = fuseLane(
      "doc",
      [
        { id: 1, rank: 0 },
        { id: 2, rank: 1 },
      ],
      [],
      meta,
      small,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(1);
  });
});

describe("effectiveSourceCaps", () => {
  it("raises every cap that sits below the caller's total limit", () => {
    // The measured defect: with the 10/10/10 default, limit:40 returned 30 —
    // an undocumented ceiling at the sum of the caps — and the answer was the
    // union of per-lane top-10s rather than the global top-40.
    const cfg = defaultConfig("/tmp/x");
    expect(effectiveSourceCaps(cfg, 40)).toEqual({ fact: 40, session: 40, doc: 40 });
    // single-source recall: one lane must be able to fill the whole answer
    expect(effectiveSourceCaps(cfg, 30).doc).toBe(30);
  });

  it("preserves an explicitly-configured cap that is ABOVE the limit", () => {
    // The knob still means something: an operator who widened a lane's
    // candidate pool keeps that width, it is not overwritten with `limit`.
    const cfg = defaultConfig("/tmp/x");
    cfg.recall.sourceCaps = { fact: 50, session: 10, doc: 25 };
    expect(effectiveSourceCaps(cfg, 20)).toEqual({ fact: 50, session: 20, doc: 25 });
  });

  it("leaves caps alone when they already equal the limit, and never mutates cfg", () => {
    const cfg = defaultConfig("/tmp/x");
    const widened = withEffectiveSourceCaps(cfg, 40);
    expect(widened.recall.sourceCaps).toEqual({ fact: 40, session: 40, doc: 40 });
    // the source config is untouched — recall() must not leak a widened cap
    // into the store's long-lived cfg (or into impact()).
    expect(cfg.recall.sourceCaps).toEqual({ fact: 10, session: 10, doc: 10 });
    expect(widened.recall.boosts).toEqual(cfg.recall.boosts);
    expect(widened.recall.rrfK).toBe(cfg.recall.rrfK);
  });

  it("a widened cfg lets one lane put more than the raw cap into the ranking", () => {
    const cfg = defaultConfig("/tmp/x");
    const meta = new Map<number, CandidateMeta>();
    const vec: { id: number; rank: number }[] = [];
    for (let i = 0; i < 20; i++) {
      meta.set(i, { sourceType: "doc", id: i, active: true });
      vec.push({ id: i, rank: i });
    }
    // raw config: capped at the 10/10/10 default
    expect(fuseLane("doc", vec, [], meta, cfg)).toHaveLength(10);
    // what recall() actually passes at limit:20
    expect(fuseLane("doc", vec, [], meta, withEffectiveSourceCaps(cfg, 20))).toHaveLength(20);
  });
});

describe("recencyMultiplier", () => {
  it("is 1 at age 0 and 0.5 at one half-life", () => {
    const now = Date.parse("2026-06-21T00:00:00Z");
    expect(recencyMultiplier(new Date(now).toISOString(), 30, now)).toBeCloseTo(1);
    const oneHalfLife = new Date(now - 30 * 86_400_000).toISOString();
    expect(recencyMultiplier(oneHalfLife, 30, now)).toBeCloseTo(0.5);
  });
});

describe("orderResults (impact ordering)", () => {
  it("orders facts → sessions → active docs → historical docs", () => {
    const items: FusedItem[] = [
      { sourceType: "doc", id: 10, score: 0.9, matchedBy: "vector" },
      { sourceType: "fact", id: 1, score: 0.1, matchedBy: "lexical" },
      { sourceType: "doc", id: 11, score: 0.8, matchedBy: "vector" },
      { sourceType: "session", id: 5, score: 0.2, matchedBy: "both" },
    ];
    const meta = new Map<string, CandidateMeta>([
      ["doc:10", { sourceType: "doc", id: 10, active: false }],
      ["doc:11", { sourceType: "doc", id: 11, active: true }],
    ]);
    const ordered = orderResults(items, meta);
    expect(ordered.map((o) => `${o.sourceType}:${o.id}`)).toEqual([
      "fact:1",
      "session:5",
      "doc:11",
      "doc:10",
    ]);
  });
});

describe("rankFlat (recall ordering)", () => {
  it("puts a strongly-scoring doc above weaker sessions", () => {
    // The measured defect: a doc at 0.0417 shipped at position 21, below
    // sessions scoring 0.0080, because the old order tiered before scoring.
    const items: FusedItem[] = [
      { sourceType: "session", id: 5, score: 0.008, matchedBy: "lexical" },
      { sourceType: "session", id: 6, score: 0.008, matchedBy: "lexical" },
      { sourceType: "doc", id: 10, score: 0.0417, matchedBy: "both" },
    ];
    const meta = new Map<string, CandidateMeta>([
      ["doc:10", { sourceType: "doc", id: 10, active: true }],
    ]);
    const ranked = rankFlat(items, meta);
    expect(ranked.map((o) => `${o.sourceType}:${o.id}`)).toEqual([
      "doc:10",
      "session:5",
      "session:6",
    ]);
  });

  it("breaks exact score ties by tier then id, whatever the input order", () => {
    const items: FusedItem[] = [
      { sourceType: "doc", id: 10, score: 1 / 60, matchedBy: "lexical" },
      { sourceType: "session", id: 5, score: 1 / 60, matchedBy: "lexical" },
      { sourceType: "fact", id: 3, score: 1 / 60, matchedBy: "lexical" },
      { sourceType: "fact", id: 1, score: 1 / 60, matchedBy: "lexical" },
    ];
    const meta = new Map<string, CandidateMeta>([
      ["doc:10", { sourceType: "doc", id: 10, active: true }],
    ]);
    const ranked = rankFlat(items, meta);
    expect(ranked.map((o) => `${o.sourceType}:${o.id}`)).toEqual([
      "fact:1",
      "fact:3",
      "session:5",
      "doc:10",
    ]);
  });

  it("sorts an archived doc below an active doc at the same score", () => {
    const items: FusedItem[] = [
      { sourceType: "doc", id: 10, score: 0.5, matchedBy: "vector" },
      { sourceType: "doc", id: 11, score: 0.5, matchedBy: "vector" },
    ];
    const meta = new Map<string, CandidateMeta>([
      ["doc:10", { sourceType: "doc", id: 10, active: false }],
      ["doc:11", { sourceType: "doc", id: 11, active: true }],
    ]);
    const ranked = rankFlat(items, meta);
    expect(ranked.map((o) => o.id)).toEqual([11, 10]);
  });
});
