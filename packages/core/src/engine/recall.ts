import type { GroundedConfig, SourceType, MatchedBy } from "../contract.js";

/** A single lane hit: an item id and its 0-based rank within that lane. */
/** session-only recall dimensions — facts and docs have neither column. */
export interface SessionFilter {
  project?: string | undefined;
  workspace?: string | undefined;
}

export interface LaneHit {
  id: number;
  rank: number;
}

/** Per-item metadata the engine needs to apply boosts and final ordering. */
export interface CandidateMeta {
  sourceType: SourceType;
  id: number;
  /** facts: pinned flag. */
  pinned?: boolean;
  /** facts: importance 0..1. */
  importance?: number;
  /** sessions: ISO createdAt for recency decay. */
  createdAt?: string | null;
  /** docs: active vs archived/missing. */
  active?: boolean;
  /** facts: the fact's own scope ("global" | "project:x" | "agent:x" |
   * "machine:x"), used by the scope-affinity boost. Distinct from the doc
   * `scope` below, which is a LANE — same column name, different axis. */
  factScope?: string;
  /** docs: the lane the row lives in. Populated only by the flag-mode meta
   * fetch used by `impact()`; `recall()` never needs it, because recall drops
   * out-of-lane rows in SQL and so never sees one. */
  scope?: string;
  /** docs: false when the row's lane is outside the caller's declared lanes.
   * `impact()` keeps such rows and withholds their content; `recall()` never
   * sets this — see the filter-then-drop vs filter-then-flag note on
   * Store.impact. */
  inScope?: boolean;
}

export interface FusedItem {
  sourceType: SourceType;
  id: number;
  score: number;
  matchedBy: MatchedBy;
}

/** RRF contribution for a single rank. */
export function rrf(rrfK: number, rank: number): number {
  return 1 / (rrfK + rank);
}

/**
 * Fuse vector + lexical lanes for one source type, apply boosts, and cap.
 * Ranks are 0-based. Returns items sorted by boosted score (desc), capped.
 */
export function fuseLane(
  sourceType: SourceType,
  vectorLane: LaneHit[],
  lexicalLane: LaneHit[],
  meta: Map<number, CandidateMeta>,
  cfg: GroundedConfig,
  now: number = Date.now(),
  ctx: RecallContext = {},
): FusedItem[] {
  const rrfK = cfg.recall.rrfK;
  const boosts = cfg.recall.boosts;

  const acc = new Map<number, { base: number; inVec: boolean; inLex: boolean }>();

  for (const hit of vectorLane) {
    const cur = acc.get(hit.id) ?? { base: 0, inVec: false, inLex: false };
    cur.base += rrf(rrfK, hit.rank);
    cur.inVec = true;
    acc.set(hit.id, cur);
  }
  for (const hit of lexicalLane) {
    const cur = acc.get(hit.id) ?? { base: 0, inVec: false, inLex: false };
    cur.base += rrf(rrfK, hit.rank);
    cur.inLex = true;
    acc.set(hit.id, cur);
  }

  const fused: FusedItem[] = [];
  for (const [id, v] of acc) {
    const m = meta.get(id);
    let score = v.base;

    if (sourceType === "fact") {
      if (m?.pinned) score *= boosts.pinned;
      const importance = m?.importance ?? 0;
      score *= 1 + boosts.importance * importance;
      score *= scopeAffinityMultiplier(m?.factScope, ctx, cfg);
    } else if (sourceType === "session") {
      score *= recencyMultiplier(m?.createdAt, boosts.recencyHalfLifeDays, now);
    } else if (sourceType === "doc") {
      if (m?.active === false) {
        // historical docs are not boosted (they sit below active by tier).
      } else {
        score *= boosts.activeStatus;
      }
    }

    const matchedBy: MatchedBy =
      v.inVec && v.inLex ? "both" : v.inVec ? "vector" : "lexical";
    fused.push({ sourceType, id, score, matchedBy });
  }

  fused.sort((a, b) => b.score - a.score);
  const cap = cfg.recall.sourceCaps[sourceType];
  return fused.slice(0, cap);
}

/**
 * The caller-context a lane fusion is scored against: the raw query text and
 * the caller's declared `project`. Only the fact lane reads it today (see
 * `scopeAffinityMultiplier`); sessions filter on `project` in SQL and docs
 * filter on the `scopes` lane set, so neither needs it here.
 */
export interface RecallContext {
  query?: string | undefined;
  project?: string | undefined;
}

/** Scope-affinity verdict for one fact scope against the caller's context. */
export type ScopeAffinity = "match" | "mismatch" | "specific" | "neutral";

/** `boosts.scopeAffinity` — the fact's scope names the caller's declared
 * project, or its own name appears as a word in the query. */
export const DEFAULT_SCOPE_AFFINITY = 1.5;
/** `boosts.scopeMismatch` — the caller declared a project and the fact is
 * scoped to a DIFFERENT project. Demotes, never drops: the fact may still win
 * on raw relevance. */
export const DEFAULT_SCOPE_MISMATCH = 0.8;
/** `boosts.scopeSpecificity` — a deliberately narrowed (non-global) fact under
 * a neutral context. A fact whose author scoped it to one project is more
 * specific than an unrelated global rule, and the RRF spread between them is
 * routinely noise (measured 0.032 vs 0.040 on the query that exposed this),
 * so specificity is the honest tiebreak. */
export const DEFAULT_SCOPE_SPECIFICITY = 1.3;

/** Split a fact scope into its kind and name: "project:alpha" -> both parts;
 * "global" (or any bare token) -> kind null, name = the token. */
export function splitScope(scope: string): { kind: string | null; name: string } {
  const i = scope.indexOf(":");
  if (i === -1) return { kind: null, name: scope };
  return { kind: scope.slice(0, i), name: scope.slice(i + 1) };
}

/** True when `name` occurs as a whole word (case-insensitive) in `query`.
 * Word-bounded on purpose: a scope named "api" must not match "apiary". */
function queryNamesScope(query: string | undefined, name: string): boolean {
  if (!query || !name) return false;
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  return tokens.includes(name.toLowerCase());
}

/**
 * How a fact's own scope relates to the caller's context.
 *
 *  - `match`     — the scope names the caller's declared project, or its name
 *                  appears as a word in the query ("what is left on stunt3d").
 *  - `mismatch`  — the caller declared a project and this fact belongs to a
 *                  different one.
 *  - `specific`  — a non-global scope under a context that neither names nor
 *                  contradicts it.
 *  - `neutral`   — a global fact, or an unscoped one.
 */
export function scopeAffinity(
  factScope: string | undefined,
  ctx: RecallContext,
): ScopeAffinity {
  if (!factScope || factScope === "global") return "neutral";
  const { kind, name } = splitScope(factScope);
  if (queryNamesScope(ctx.query, name)) return "match";
  if (ctx.project) {
    if (kind === "project") {
      return name === ctx.project ? "match" : "mismatch";
    }
  }
  return "specific";
}

/**
 * The scope-affinity multiplier for one fact — the fourth named fact boost,
 * alongside `pinned` and `importance`.
 *
 * Why it exists: before it, a fact deliberately scoped to a project competed
 * against the ENTIRE global lane on raw RRF score, and RRF spreads inside a
 * lane are frequently noise. A `project:stunt3d` fact that literally contained
 * the query's rare terms ranked 4th behind three global facts sharing no term
 * with the query, at 0.032 vs 0.040. Scope is the signal that was being thrown
 * away: someone narrowed that fact on purpose.
 *
 * Each tier is a separate configurable knob so an operator can turn any of them
 * off independently (set to 1). Defaults are the DEFAULT_SCOPE_* constants
 * above; they are read with `??` so a config that predates these keys keeps
 * working unchanged.
 */
export function scopeAffinityMultiplier(
  factScope: string | undefined,
  ctx: RecallContext,
  cfg: GroundedConfig,
): number {
  const boosts = cfg.recall.boosts;
  switch (scopeAffinity(factScope, ctx)) {
    case "match":
      return boosts.scopeAffinity ?? DEFAULT_SCOPE_AFFINITY;
    case "mismatch":
      return boosts.scopeMismatch ?? DEFAULT_SCOPE_MISMATCH;
    case "specific":
      return boosts.scopeSpecificity ?? DEFAULT_SCOPE_SPECIFICITY;
    default:
      return 1;
  }
}

/**
 * The per-lane cap `recall()` actually fuses with, given the caller's total
 * `limit`.
 *
 * `sourceCaps` is a RANKING cap on how much of ONE lane may enter the flat
 * ranking — it must never bound the TOTAL answer. Once `limit` became a total
 * across sources, applying the raw caps inside `fuseLane` did two wrong things:
 *
 *  1. it hard-ceilinged every response at Σ sourceCaps (with the 10/10/10
 *     default, `limit: 40` and `limit: 60` both returned exactly 30, and
 *     `sources:["doc"], limit: 30` returned 10);
 *  2. worse, it made the answer the UNION OF PER-LANE TOP-Ns instead of the
 *     global top-`limit` — a doc ranked 11th in its lane was dropped even when
 *     it outscored the 8th-ranked fact, which defeats flat score ranking.
 *
 * So raise each cap to at least `limit`: any single lane may supply the whole
 * answer when it earns it. `Math.max` and not a plain assignment, so an
 * operator who deliberately configured a cap ABOVE `limit` keeps the wider
 * candidate pool they asked for — the knob still means something.
 *
 * This is the same reasoning `impact()` already applies (caps are a ranking
 * cap, not a result bound); impact keeps its own stricter `= limit` clone
 * because a dependency pre-flight is authoritative on `limit` alone.
 *
 * The SQL candidate fetch does not need adjusting to match: `laneN` is
 * `max(limit * 3, 20)`, so it is ≥ `limit` at every limit and grows with it —
 * a widened fuse-cap can never ask a lane for more candidates than were
 * fetched.
 */
export function effectiveSourceCaps(
  cfg: GroundedConfig,
  limit: number,
): Record<SourceType, number> {
  const caps = cfg.recall.sourceCaps;
  return {
    fact: Math.max(caps.fact, limit),
    session: Math.max(caps.session, limit),
    doc: Math.max(caps.doc, limit),
  };
}

/** `cfg` with `recall.sourceCaps` widened by `effectiveSourceCaps`. */
export function withEffectiveSourceCaps(
  cfg: GroundedConfig,
  limit: number,
): GroundedConfig {
  return {
    ...cfg,
    recall: { ...cfg.recall, sourceCaps: effectiveSourceCaps(cfg, limit) },
  };
}

/** Exponential recency decay: 1.0 at age 0, 0.5 at one half-life. */
export function recencyMultiplier(
  createdAt: string | null | undefined,
  halfLifeDays: number,
  now: number,
): number {
  if (!createdAt || halfLifeDays <= 0) return 1;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 1;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Recall's answer order: one flat list ranked by fused score, descending —
 * the top of the list is the best match regardless of which source it came
 * from. `limit` is therefore a TOTAL across sources, not a per-lane quota, and
 * grouping into fact/session/doc sections is the caller's job (the UI regroups
 * client-side; MCP renders flat).
 *
 * The tier/id tiebreak is not cosmetic: RRF scores tie exactly (1/60 for a
 * single lane hit at rank 0), and lane insertion order differs between adapters
 * (sqlite hardcodes fact→session→doc, postgres iterates the caller's `sources`),
 * so without a deterministic tiebreak the shared store suite flakes across
 * adapters. Tier shape matches `orderResults` — which stays impact-only.
 */
export function rankFlat(
  items: FusedItem[],
  meta: Map<string, CandidateMeta>,
): FusedItem[] {
  function tier(it: FusedItem): number {
    if (it.sourceType === "fact") return 0;
    if (it.sourceType === "session") return 1;
    const m = meta.get(`${it.sourceType}:${it.id}`);
    return m?.active === false ? 3 : 2;
  }
  return [...items].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
}

/**
 * How the lexical lane matched, and whether it contributed at all.
 *
 *  - `strict`  — the query matched AS WRITTEN: every term present in the same
 *                row. The precise reading, and the default attempt.
 *  - `relaxed` — no row satisfied every term in at least one requested source,
 *                so that lane was retried with the terms OR-ed. Fires ONLY on a
 *                strict lane that returned zero rows, so it can add signal
 *                where there was none and can never dilute a strict match.
 *  - `none`    — even relaxed matched nothing anywhere. If the vector lane is
 *                live, THIS RANKING IS VECTOR-ONLY.
 *
 * Why this is reported rather than left to the reader: a natural-language
 * query ("is zap decommissioned yet") ANDs its bare words in postgres'
 * `websearch_to_tsquery`, matched nothing, and recall degraded to a pure ANN
 * ranking whose whole score spread was noise (0.032-0.040) — silently. An agent
 * must be able to see that its ranking had no lexical anchor without running an
 * experiment.
 */
export type LexicalMode = "strict" | "relaxed" | "none";

/**
 * `DeliveryMeta.lexical` for one recall call.
 *
 * `candidates` counts RAW lexical lane hits summed across the requested
 * sources, before scope/status filtering and before fusion — it answers "did
 * the lexical half of hybrid recall fire", not "how many rows survived".
 * `relaxedSources` names the lanes that fell back, because a query can match
 * strictly in docs and not at all in facts; `mode` is `relaxed` if ANY lane
 * did.
 */
export function lexicalMeta(
  candidates: number,
  relaxedSources: SourceType[],
  vectorActive: boolean,
): NonNullable<import("../contract.js").DeliveryMeta["lexical"]> {
  const mode: LexicalMode =
    candidates === 0 ? "none" : relaxedSources.length > 0 ? "relaxed" : "strict";
  return {
    mode,
    candidates,
    relaxedSources: [...relaxedSources],
    vectorOnly: candidates === 0 && vectorActive,
  };
}

/**
 * Minimum doc slots reserved inside `limit` when the caller EXPLICITLY declared
 * `scopes`. One, not more: the point is that a caller who filtered the doc lane
 * always learns whether that lane had an answer, not that docs get a quota.
 * Applied only on an explicit `scopes` — the default `['global']` read-set
 * leaves flat ranking completely untouched.
 */
export const DOC_LANE_FLOOR = 1;

/**
 * `DeliveryMeta.scopeFilter` for one recall call — which of the REQUESTED
 * sources the `scopes` filter actually applied to. Docs are laned; facts and
 * sessions are not (their `scope` is a different axis, filtered by `project`).
 * Reported on every recall so the exemption can never be silent again.
 */
export function scopeFilterMeta(
  sources: SourceType[],
  declared: string[],
  explicit: boolean,
): NonNullable<import("../contract.js").DeliveryMeta["scopeFilter"]> {
  return {
    declared: [...declared],
    defaulted: !explicit,
    appliedTo: sources.filter((s) => s === "doc"),
    exempt: sources.filter((s) => s !== "doc"),
  };
}

/**
 * Guarantee a lane a minimum number of slots inside the caller's `limit`,
 * without abandoning flat score ranking for a per-lane quota.
 *
 * The case it exists for: `scopes` is the DOC-lane filter (facts and sessions
 * are a different axis — see `RecallOptions.scopes`). A caller who narrows the
 * doc lane to `["archive"]` and gets back six unrelated global FACTS, zero
 * docs, has been told nothing about whether the lane they filtered had an
 * answer — the observed defect. Facts are still allowed to win the ranking;
 * they are not allowed to make the filtered lane invisible.
 *
 * Reorders rather than slices, so the caller's own cut at `limit` (postgres
 * backfills past hydration nulls, sqlite slices) is unchanged. Promotes the
 * highest-ranked out-of-window items of `sourceType` into the window, evicting
 * the LOWEST-ranked items of other types from it; relative order is otherwise
 * preserved. A no-op when the window already meets the floor, when the lane has
 * nothing more to give, or when `floor >= limit` would turn the answer into a
 * single-lane quota (the floor is clamped to `limit - 1`, so at least one slot
 * always stays open to the ranking).
 */
export function applyLaneFloor(
  ranked: FusedItem[],
  sourceType: SourceType,
  floor: number,
  limit: number,
): FusedItem[] {
  const cap = Math.min(floor, Math.max(limit - 1, 0));
  if (cap <= 0 || ranked.length <= limit) return ranked;
  const head = ranked.slice(0, limit);
  const tail = ranked.slice(limit);
  const present = head.filter((f) => f.sourceType === sourceType).length;
  const needed = cap - present;
  if (needed <= 0) return ranked;
  const promote = tail.filter((f) => f.sourceType === sourceType).slice(0, needed);
  if (promote.length === 0) return ranked;
  const promoted = new Set(promote);
  // evict the lowest-ranked other-type items from the window, newest-first from
  // the bottom, exactly as many as we promote.
  const evictable: FusedItem[] = [];
  for (let i = head.length - 1; i >= 0 && evictable.length < promote.length; i--) {
    const f = head[i]!;
    if (f.sourceType !== sourceType) evictable.push(f);
  }
  const evicted = new Set(evictable);
  const newHead = head.filter((f) => !evicted.has(f)).concat(promote);
  const rest = tail.filter((f) => !promoted.has(f));
  // evicted items keep their relative order, just below the window.
  const demoted = head.filter((f) => evicted.has(f));
  return [...newHead, ...demoted, ...rest];
}

/**
 * Impact-only cross-source ordering: facts → recent sessions → active docs →
 * historical docs. Within a tier, by score descending. `recall()` uses
 * `rankFlat` above; a dependency pre-flight keeps the sectioned model because
 * the reader is scanning categories ("what facts / what sessions / what docs
 * depend on this?"), not reading a top-N list.
 */
export function orderResults(
  items: FusedItem[],
  meta: Map<string, CandidateMeta>,
): FusedItem[] {
  function tier(it: FusedItem): number {
    if (it.sourceType === "fact") return 0;
    if (it.sourceType === "session") return 1;
    const m = meta.get(`${it.sourceType}:${it.id}`);
    return m?.active === false ? 3 : 2;
  }
  return [...items].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return b.score - a.score;
  });
}
