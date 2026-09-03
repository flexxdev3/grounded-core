import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config.js";
import {
  rrf,
  fuseLane,
  applyLaneFloor,
  scopeAffinity,
  scopeAffinityMultiplier,
  lexicalMeta,
  scopeFilterMeta,
  splitScope,
  recallFactScopes,
  GLOBAL_SCOPE,
  DEFAULT_SCOPE_AFFINITY,
  DEFAULT_SCOPE_MISMATCH,
  DEFAULT_SCOPE_SPECIFICITY,
  recencyMultiplier,
  orderResults,
  rankFlat,
  DEFAULT_TIE_BREAK_ORDER,
  effectiveSourceCaps,
  withEffectiveSourceCaps,
  embedQueryText,
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
    // multipliers read from the config, never restated here — the sibling test
    // above does the same. f1 = pinned × (1 + importance·weight).
    const b = cfg.recall.boosts;
    expect(f1.score).toBeGreaterThan(f2.score);
    expect(f1.score).toBeCloseTo((1 / 60) * b.pinned * (1 + b.importance * 1));
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

describe("the doctrine, as arithmetic (docs are not crowded out by facts)", () => {
  it("a doc matching BOTH lanes outscores a pinned importance-0.95 fact matching one", () => {
    // THE measured bug: `{"query":"sentient charts","limit":20}` returned 15
    // facts / 5 docs with the top 3 all pinned global facts, because the fact
    // stack ceiling was 4.5× (pinned 1.5 × importance 2.0 × scope 1.5) against
    // a doc's 1.25×. Live, fact:73 scored 0.046 on the VECTOR lane alone,
    // above doc:369's 0.033 on BOTH. That must not be expressible again.
    const cfg = defaultConfig("/tmp/x");
    const factMeta = new Map<number, CandidateMeta>([
      [1, { sourceType: "fact", id: 1, pinned: true, importance: 0.95, factScope: "global" }],
    ]);
    const docMeta = new Map<number, CandidateMeta>([
      [2, { sourceType: "doc", id: 2, active: true }],
    ]);
    const fact = fuseLane("fact", [{ id: 1, rank: 0 }], [], factMeta, cfg)[0]!;
    const doc = fuseLane("doc", [{ id: 2, rank: 0 }], [{ id: 2, rank: 0 }], docMeta, cfg)[0]!;
    expect(doc.score).toBeGreaterThan(fact.score);
    // and by a real margin, not a rounding accident
    expect(doc.score / fact.score).toBeGreaterThan(1.5);
  });

  it("the fact stack's ceiling is now BELOW the old floor", () => {
    const b = defaultConfig("/tmp/x").recall.boosts;
    // old: pinned 1.5 × (1 + 1.0·1) × scopeAffinity 1.5 = 4.5
    const ceiling = b.pinned * (1 + b.importance * 1) * (b.scopeAffinity ?? 1.5);
    expect(ceiling).toBeCloseTo(2.25);
    expect(ceiling).toBeLessThan(4.5);
  });
});

describe("effectiveSourceCaps", () => {
  it("raises every cap that sits below the caller's total limit", () => {
    // The measured defect: with the 10/10/10 default, limit:40 returned 30 —
    // an undocumented ceiling at the sum of the caps — and the answer was the
    // union of per-lane top-10s rather than the global top-40.
    const cfg = defaultConfig("/tmp/x");
    // `laneShare` bounds this on top (see the laneShare cases below); read the
    // widening on its own by taking the share out.
    const unshared = { ...cfg, recall: { ...cfg.recall, laneShare: undefined } };
    expect(effectiveSourceCaps(unshared, 40)).toEqual({ fact: 40, session: 40, doc: 40 });
    // single-source recall: one lane must be able to fill the whole answer
    expect(effectiveSourceCaps(cfg, 30).doc).toBe(30);
  });

  it("preserves an explicitly-configured cap that is ABOVE the limit", () => {
    // The knob still means something: an operator who widened a lane's
    // candidate pool keeps that width, it is not overwritten with `limit`.
    const cfg = defaultConfig("/tmp/x");
    cfg.recall.sourceCaps = { fact: 50, session: 10, doc: 25 };
    const unshared = { ...cfg, recall: { ...cfg.recall, laneShare: undefined } };
    expect(effectiveSourceCaps(unshared, 20)).toEqual({ fact: 50, session: 20, doc: 25 });
    // with the default shares in force the bound wins for the shared lanes, but
    // `doc: 1` is unbounded and the operator's wider 25 survives.
    expect(effectiveSourceCaps(cfg, 20)).toEqual({ fact: 5, session: 10, doc: 25 });
  });

  it("leaves caps alone when they already equal the limit, and never mutates cfg", () => {
    const cfg = defaultConfig("/tmp/x");
    // share taken out so this reads the widening alone — the share bound has
    // its own cases above.
    const unshared = { ...cfg, recall: { ...cfg.recall, laneShare: undefined } };
    const widened = withEffectiveSourceCaps(unshared, 40);
    expect(widened.recall.sourceCaps).toEqual({ fact: 40, session: 40, doc: 40 });
    // the source config is untouched — recall() must not leak a widened cap
    // into the store's long-lived cfg (or into impact()).
    expect(cfg.recall.sourceCaps).toEqual({ fact: 10, session: 10, doc: 10 });
    expect(widened.recall.boosts).toEqual(cfg.recall.boosts);
    expect(widened.recall.rrfK).toBe(cfg.recall.rrfK);
  });

  it("bounds a multi-source lane to ceil(limit * laneShare), and never to 0", () => {
    // The measured defect the share exists for: at limit 20 the widening made
    // every cap 20, and the fact lane returned 15 of the 20 rows.
    const cfg = defaultConfig("/tmp/x");
    expect(cfg.recall.laneShare).toEqual({ fact: 0.25, session: 0.5, doc: 1 });
    expect(effectiveSourceCaps(cfg, 20, ["fact", "session", "doc"])).toEqual({
      fact: 5,
      session: 10,
      doc: 20,
    });
    // the floor: a share can never round a lane out of the answer entirely
    expect(effectiveSourceCaps(cfg, 1, ["fact", "doc"]).fact).toBe(1);
    expect(effectiveSourceCaps(cfg, 2, ["fact", "doc"]).fact).toBe(1);
  });

  it("SINGLE-source recall is share-exempt — it gets its full limit", () => {
    // The regression this design most risks. A caller that asks for one lane
    // asked for that lane; the share is an anti-domination rule and there is
    // nothing to dominate.
    const cfg = defaultConfig("/tmp/x");
    expect(effectiveSourceCaps(cfg, 20, ["fact"]).fact).toBe(20);
    expect(effectiveSourceCaps(cfg, 3, ["fact"]).fact).toBe(10); // raw cap still wins when wider
    expect(withEffectiveSourceCaps(cfg, 20, ["fact"]).recall.sourceCaps.fact).toBe(20);
  });

  it("laneShare.fact = 1 reproduces the pre-share behaviour exactly", () => {
    const cfg = defaultConfig("/tmp/x");
    const wide = {
      ...cfg,
      recall: { ...cfg.recall, laneShare: { fact: 1, session: 1, doc: 1 } },
    };
    expect(effectiveSourceCaps(wide, 20)).toEqual({ fact: 20, session: 20, doc: 20 });
    // ...as does dropping the key altogether
    const none = { ...cfg, recall: { ...cfg.recall, laneShare: undefined } };
    expect(effectiveSourceCaps(none, 40)).toEqual({ fact: 40, session: 40, doc: 40 });
  });

  it("uses Math.min against the widened cap, not Math.max", () => {
    // With Math.max, a configured sourceCaps.fact of 10 would re-create the
    // original defect at limit 20 (cap 20, share ignored).
    const cfg = defaultConfig("/tmp/x");
    cfg.recall.sourceCaps = { fact: 10, session: 10, doc: 10 };
    expect(effectiveSourceCaps(cfg, 20).fact).toBe(5);
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
    // DEFAULT_TIE_BREAK_ORDER leads with docs: on an EXACT tie the doc wins.
    // It used to lead with facts (copied from `orderResults`), which was a
    // third place the fact lane won by construction rather than by relevance.
    expect(ranked.map((o) => `${o.sourceType}:${o.id}`)).toEqual([
      "doc:10",
      "fact:1",
      "fact:3",
      "session:5",
    ]);
  });

  it("honours a custom tieBreakOrder, and still forces archived docs last", () => {
    const items: FusedItem[] = [
      { sourceType: "doc", id: 10, score: 1 / 60, matchedBy: "lexical" },
      { sourceType: "doc", id: 12, score: 1 / 60, matchedBy: "lexical" },
      { sourceType: "session", id: 5, score: 1 / 60, matchedBy: "lexical" },
      { sourceType: "fact", id: 1, score: 1 / 60, matchedBy: "lexical" },
    ];
    const meta = new Map<string, CandidateMeta>([
      ["doc:10", { sourceType: "doc", id: 10, active: true }],
      // archived: last regardless of where "doc" sits in the order
      ["doc:12", { sourceType: "doc", id: 12, active: false }],
    ]);
    expect(
      rankFlat(items, meta, ["session", "fact", "doc"]).map((o) => `${o.sourceType}:${o.id}`),
    ).toEqual(["session:5", "fact:1", "doc:10", "doc:12"]);
    // and the default is the config's
    expect(defaultConfig("/tmp/x").recall.tieBreakOrder).toEqual(DEFAULT_TIE_BREAK_ORDER);
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


describe("recallFactScopes (fact-lane hard filter)", () => {
  it("a declared project means global + that project, nothing else", () => {
    expect(recallFactScopes({ project: "alpha" })).toEqual([GLOBAL_SCOPE, "project:alpha"]);
    expect(GLOBAL_SCOPE).toBe("global");
  });

  it("declaring NOTHING is null, not a filter — agent:/machine: facts survive", () => {
    // deliberate: a plain /recall and the SessionStart brief must keep seeing
    // scopes no `project` could ever name.
    expect(recallFactScopes({})).toBeNull();
    expect(recallFactScopes({ factScopes: [] })).toBeNull();
    expect(recallFactScopes({ project: "" })).toBeNull();
  });

  it("explicit factScopes win over project, and are de-duplicated", () => {
    expect(recallFactScopes({ factScopes: ["machine:x"], project: "alpha" })).toEqual([
      "machine:x",
    ]);
    expect(recallFactScopes({ factScopes: ["global", "global", "agent:c"] })).toEqual([
      "global",
      "agent:c",
    ]);
  });
});

describe("scopeFilterMeta", () => {
  const all: import("../contract.js").SourceType[] = ["fact", "session", "doc"];

  it("leaves the fact lane exempt when it was not narrowed", () => {
    const m = scopeFilterMeta(all, ["global"], false);
    expect(m.appliedTo).toEqual(["doc"]);
    expect(m.exempt).toEqual(["fact", "session"]);
    expect(m.factScopes).toBeUndefined();
  });

  it("moves 'fact' from exempt to appliedTo when the fact lane WAS narrowed", () => {
    const m = scopeFilterMeta(all, ["global"], false, ["global", "project:alpha"]);
    expect(m.appliedTo).toEqual(["fact", "doc"]);
    expect(m.exempt).toEqual(["session"]);
    // reported on its own key: `declared` is the DOC set, a different axis.
    expect(m.factScopes).toEqual(["global", "project:alpha"]);
    expect(m.declared).toEqual(["global"]);
  });

  it("never claims the fact lane was filtered when facts were not requested", () => {
    const m = scopeFilterMeta(["doc"], ["global"], true, ["global"]);
    expect(m.appliedTo).toEqual(["doc"]);
    expect(m.factScopes).toBeUndefined();
  });
});

describe("scope affinity (fact lane)", () => {
  const cfg = defaultConfig("/tmp/x");

  it("splits a scope into kind + name; a bare scope has no kind", () => {
    expect(splitScope("project:stunt3d")).toEqual({ kind: "project", name: "stunt3d" });
    expect(splitScope("global")).toEqual({ kind: null, name: "global" });
  });

  it("global and unscoped facts are neutral (multiplier 1)", () => {
    expect(scopeAffinity("global", {})).toBe("neutral");
    expect(scopeAffinity(undefined, { project: "stunt3d" })).toBe("neutral");
    expect(scopeAffinityMultiplier("global", { project: "stunt3d" }, cfg)).toBe(1);
  });

  it("matches when the caller declares that project", () => {
    expect(scopeAffinity("project:stunt3d", { project: "stunt3d" })).toBe("match");
    expect(scopeAffinityMultiplier("project:stunt3d", { project: "stunt3d" }, cfg)).toBe(
      DEFAULT_SCOPE_AFFINITY,
    );
  });

  it("matches when the query names the scope, word-bounded", () => {
    expect(scopeAffinity("project:stunt3d", { query: "what is left on stunt3d" })).toBe("match");
    // a substring is not a match: "api" must not fire on "apiary"
    expect(scopeAffinity("project:api", { query: "the apiary notes" })).toBe("specific");
  });

  it("mismatches a different declared project, and demotes rather than drops", () => {
    expect(scopeAffinity("project:stunt3d", { project: "grounded" })).toBe("mismatch");
    const m = scopeAffinityMultiplier("project:stunt3d", { project: "grounded" }, cfg);
    expect(m).toBe(DEFAULT_SCOPE_MISMATCH);
    expect(m).toBeGreaterThan(0);
  });

  it("a non-project scope under a declared project is specific, not a mismatch", () => {
    // Still true of the classifier, and kept: a passing invariant is not
    // deleted because it got harder to reach. Note that under a declared
    // `project` the fact-scope HARD FILTER (`recallFactScopes`) now removes
    // `agent:`/`machine:` rows in SQL upstream of this, so `specific` is
    // reached in recall only when nothing was declared.
    expect(scopeAffinity("agent:claude", { project: "grounded" })).toBe("specific");
  });

  it("scopeSpecificity is OFF by default — a narrowed fact gets no free lift", () => {
    // Replaces the old "narrowed fact outranks an unrelated global one in the
    // noise band" case. That doctrine is retired: `specific` promoted rows on
    // no query evidence at all, and the foreign-project rows it was aimed at
    // are now removed upstream by the fact-scope hard filter. A scope that the
    // context neither names nor contradicts is worth exactly 1.
    expect(DEFAULT_SCOPE_SPECIFICITY).toBe(1);
    const meta = new Map<number, CandidateMeta>([
      [1, { sourceType: "fact", id: 1, importance: 0.6, factScope: "global" }],
      [2, { sourceType: "fact", id: 2, importance: 0.6, factScope: "project:stunt3d" }],
    ]);
    const lex = [
      { id: 1, rank: 0 },
      { id: 2, rank: 1 },
    ];
    // neutral context: the better lexical rank wins, scope buys nothing.
    const neutral = fuseLane("fact", [], lex, meta, cfg, Date.now(), {
      query: "is the box dead yet",
    });
    expect(neutral[0]!.id).toBe(1);
  });

  it("the two surviving mechanisms still lift a narrowed fact over a global one", () => {
    // `match` — the query NAMES the scope, or the caller DECLARES the project.
    // Both read the caller's context; `specific` did not, which is why it went.
    const meta = new Map<number, CandidateMeta>([
      [1, { sourceType: "fact", id: 1, importance: 0.6, factScope: "global" }],
      [2, { sourceType: "fact", id: 2, importance: 0.6, factScope: "project:stunt3d" }],
    ]);
    const lex = [
      { id: 1, rank: 0 },
      { id: 2, rank: 1 },
    ];
    const named = fuseLane("fact", [], lex, meta, cfg, Date.now(), {
      query: "is stunt3d dead yet",
    });
    expect(named[0]!.id).toBe(2);
    const declared = fuseLane("fact", [], lex, meta, cfg, Date.now(), { project: "stunt3d" });
    expect(declared[0]!.id).toBe(2);
    // and the lift is exactly the `match` tier
    const base = fuseLane("fact", [], lex, meta, cfg, Date.now(), { query: "unrelated" });
    expect(
      named.find((f) => f.id === 2)!.score / base.find((f) => f.id === 2)!.score,
    ).toBeCloseTo(DEFAULT_SCOPE_AFFINITY);
  });

  it("every tier is disable-able by config (set the knob to 1)", () => {
    const flat = {
      ...cfg,
      recall: {
        ...cfg.recall,
        boosts: {
          ...cfg.recall.boosts,
          scopeAffinity: 1,
          scopeMismatch: 1,
          scopeSpecificity: 1,
        },
      },
    };
    expect(scopeAffinityMultiplier("project:a", { project: "a" }, flat)).toBe(1);
    expect(scopeAffinityMultiplier("project:a", { project: "b" }, flat)).toBe(1);
    expect(scopeAffinityMultiplier("project:a", {}, flat)).toBe(1);
  });
});

describe("applyLaneFloor", () => {
  const facts: FusedItem[] = [1, 2, 3, 4].map((id) => ({
    sourceType: "fact" as const,
    id,
    score: 1 / id,
    matchedBy: "lexical" as const,
  }));
  const doc: FusedItem = { sourceType: "doc", id: 9, score: 0.01, matchedBy: "lexical" };

  it("promotes the best out-of-window doc into the window, evicting the worst other-type item", () => {
    const out = applyLaneFloor([...facts, doc], "doc", 1, 3);
    const window = out.slice(0, 3);
    expect(window.some((f) => f.sourceType === "doc")).toBe(true);
    // the two best facts keep their slots; the third is demoted, not dropped
    expect(window[0]!.id).toBe(1);
    expect(window[1]!.id).toBe(2);
    expect(out).toHaveLength(5);
    expect(out.map((f) => f.id)).toContain(3);
  });

  it("is a no-op when the window already meets the floor, or the lane is empty", () => {
    const already = [doc, ...facts];
    expect(applyLaneFloor(already, "doc", 1, 3)).toBe(already);
    expect(applyLaneFloor(facts, "doc", 1, 3)).toBe(facts);
  });

  it("floor 0 (the default read-set) never touches flat ranking", () => {
    const input = [...facts, doc];
    expect(applyLaneFloor(input, "doc", 0, 3)).toBe(input);
  });

  it("never turns the answer into a single-lane quota — floor is clamped to limit-1", () => {
    const docs: FusedItem[] = [9, 10, 11].map((id) => ({
      sourceType: "doc" as const,
      id,
      score: 0.001 * id,
      matchedBy: "lexical" as const,
    }));
    const out = applyLaneFloor([...facts, ...docs], "doc", 5, 2).slice(0, 2);
    expect(out.filter((f) => f.sourceType === "doc")).toHaveLength(1);
    expect(out.filter((f) => f.sourceType === "fact")).toHaveLength(1);
  });
});

describe("scopeFilterMeta", () => {
  it("reports the lanes the filter applied to and the sources exempt from it", () => {
    expect(scopeFilterMeta(["fact", "session", "doc"], ["archive"], true)).toEqual({
      declared: ["archive"],
      defaulted: false,
      appliedTo: ["doc"],
      exempt: ["fact", "session"],
    });
  });

  it("names the default read-set and flags it as defaulted", () => {
    expect(scopeFilterMeta(["doc"], ["global"], false)).toEqual({
      declared: ["global"],
      defaulted: true,
      appliedTo: ["doc"],
      exempt: [],
    });
  });
});


describe("lexicalMeta", () => {
  it("reports strict when the query matched as written", () => {
    expect(lexicalMeta(7, [], true)).toEqual({
      mode: "strict",
      candidates: 7,
      relaxedSources: [],
      vectorOnly: false,
    });
  });

  it("reports relaxed and names the lanes that fell back", () => {
    const m = lexicalMeta(3, ["fact"], true);
    expect(m.mode).toBe("relaxed");
    expect(m.relaxedSources).toEqual(["fact"]);
    expect(m.vectorOnly).toBe(false);
  });

  it("reports none, and flags a vector-only ranking when the vector lane is live", () => {
    expect(lexicalMeta(0, [], true).mode).toBe("none");
    expect(lexicalMeta(0, [], true).vectorOnly).toBe(true);
    // no vector lane either — the answer is empty, not vector-only.
    expect(lexicalMeta(0, [], false).vectorOnly).toBe(false);
  });
});

describe("embedQueryText (query case-folding for the vector lane)", () => {
  it("folds case and trims so 'Sentient Charts' embeds as 'sentient charts'", () => {
    expect(embedQueryText("Sentient Charts")).toBe("sentient charts");
    expect(embedQueryText("  SENTIENT CHARTS ")).toBe("sentient charts");
    expect(embedQueryText("sentient charts")).toBe("sentient charts");
  });
});
