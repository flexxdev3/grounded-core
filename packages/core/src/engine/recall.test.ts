import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config.js";
import {
  rrf,
  fuseLane,
  recencyMultiplier,
  orderResults,
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

describe("recencyMultiplier", () => {
  it("is 1 at age 0 and 0.5 at one half-life", () => {
    const now = Date.parse("2026-06-21T00:00:00Z");
    expect(recencyMultiplier(new Date(now).toISOString(), 30, now)).toBeCloseTo(1);
    const oneHalfLife = new Date(now - 30 * 86_400_000).toISOString();
    expect(recencyMultiplier(oneHalfLife, 30, now)).toBeCloseTo(0.5);
  });
});

describe("orderResults", () => {
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
