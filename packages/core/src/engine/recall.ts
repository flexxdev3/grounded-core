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
  /** docs: the source file this chunk came from. Present only on the recall
   * path, and only so `fuseLane` can roll a file's chunks up into one result —
   * see the document-rollup note there. */
  path?: string | null;
  /** docs: the ingest source, the other half of the rollup key (two sources
   * can legitimately hold the same relative path). */
  source?: string | null;
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
  /** docs: how many chunks of this file were rolled up into this row (1 when
   * only one chunk matched). Absent on facts and sessions, which have nothing
   * to roll up. */
  chunks?: number;
}

/**
 * The text handed to the embedder for a recall query. Case-folded on purpose:
 * `nomic-embed-text` is case-sensitive, and measured live (2026-09-03, :5433)
 * "Sentient Charts" landed far from the sentient corpus while "sentient charts"
 * hit it at rank 1 with `matchedBy: both` — same words, top score 0.0208 vs
 * 0.0365, and the vector-only fact lane took ranks 1-4 by default. The lexical
 * lane was already case-insensitive (tsquery / FTS5), so only the vector lane
 * moved. Stored content is embedded as written; folding the query alone
 * measured better than folding neither, so this touches nothing on disk.
 */
export function embedQueryText(query: string): string {
  return query.trim().toLowerCase();
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

  // DOCUMENT ROLLUP — collapse chunks of the same file into ONE row carrying
  // its best-scoring chunk, before the cap.
  //
  // Measured: a docs-only "sentient charts" returned 10 chunks from 5 distinct
  // files (CLAUDE.md ×3, TECH-SPECS ×3, STATE ×2), with the chunk that actually
  // held the answer at rank 8 and two more answer chunks outside the top 10. A
  // file eats many slots while its best chunk sinks. Rolling up puts the right
  // document at rank 1, and a document-level row is also what a whole-document
  // viewer wants.
  //
  // ABOVE the cap, deliberately: deduping after `slice` would return FEWER
  // documents than the caller asked for. Rows with no `path` in meta (facts,
  // sessions, and any doc row whose meta predates this) are never merged.
  const deduped: FusedItem[] = [];
  const byPath = new Map<string, FusedItem>();
  for (const item of fused) {
    const m = meta.get(item.id);
    if (!m?.path) {
      deduped.push(item);
      continue;
    }
    const key = `${m.source ?? ""}|${m.path}`;
    const seen = byPath.get(key);
    if (seen) {
      // `fused` is already score-descending, so the first hit IS the best
      // chunk; later ones only add to the count.
      seen.chunks = (seen.chunks ?? 1) + 1;
      continue;
    }
    item.chunks = 1;
    byPath.set(key, item);
    deduped.push(item);
  }

  const cap = cfg.recall.sourceCaps[sourceType];
  return deduped.slice(0, cap);
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
 * a neutral context.
 *
 * Now 1.0 (off by default). It was 1.3, on the reasoning that a narrowed fact
 * is more specific than an unrelated global rule. Under the fact-scope HARD
 * FILTER (`recallFactScopes`) a declared `project` already removes the foreign
 * project rows outright, so the only rows this tier could still inflate were
 * `agent:`/`machine:` scopes — which `scopeAffinity` can never return
 * `mismatch` for, so they were uniformly promoted with no query evidence. The
 * two surviving mechanisms are the ones that read the caller's context: the
 * query NAMES the scope, or the caller DECLARES the project (`match`). */
export const DEFAULT_SCOPE_SPECIFICITY = 1.0;

/** Split a fact scope into its kind and name: "project:alpha" -> both parts;
 * "global" (or any bare token) -> kind null, name = the token. */
export function splitScope(scope: string): { kind: string | null; name: string } {
  const i = scope.indexOf(":");
  if (i === -1) return { kind: null, name: scope };
  return { kind: scope.slice(0, i), name: scope.slice(i + 1) };
}

/** The scope every fact falls back to, and the one that ALWAYS passes the
 * fact-scope filter: a global fact is a guardrail for every context. */
export const GLOBAL_SCOPE = "global";

/**
 * The fact-lane scope filter for one recall call — a HARD filter, not a boost.
 *
 * `project` used to be a hard SQL `where` for sessions and a mere multiplier
 * for facts, so narrowing to a project SHRANK the session lane and left the
 * fact lane at full width: measured, `{"query":"sentient charts"}` returned 14
 * facts belonging to unrelated projects. Declaring a project now means
 * "`global` + this project's facts", the same filter-then-drop the doc lane
 * already uses for its `scopes` set.
 *
 * `null` when the caller declared NOTHING is deliberate, not an oversight: a
 * plain `/recall` and the SessionStart brief must keep seeing `agent:` and
 * `machine:` facts, which no `project` could ever name.
 */
export function recallFactScopes(opts: {
  factScopes?: string[] | undefined;
  project?: string | undefined;
}): string[] | null {
  if (opts.factScopes && opts.factScopes.length > 0) return [...new Set(opts.factScopes)];
  if (opts.project) return [GLOBAL_SCOPE, `project:${opts.project}`];
  return null;
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
 *
 * THEN BOUND IT. The widening above is right and stays, but "any single lane
 * MAY supply the whole answer" turned out to mean "the fact lane ALWAYS does":
 * measured, `{"query":"sentient charts","limit":20}` returned 15 facts and 5
 * docs, 14 of those facts about unrelated projects. `laneShare` is the ceiling
 * on how much of a MULTI-SOURCE answer one lane may occupy, expressed as a
 * share of `limit` (fact 0.25, session 0.5, doc 1 by default — a lane with
 * share 1, or no entry at all, is unbounded).
 *
 * Three load-bearing details:
 *  - it applies only when MORE THAN ONE source was requested. A caller that
 *    asks `sources:["fact"]` asked for facts and gets its full `limit`;
 *  - the `Math.max(1, …)` floor — a share never rounds a lane down to zero;
 *  - `Math.min` against the widened cap, not `Math.max`. With `Math.max` a
 *    configured `sourceCaps.fact = 10` would re-create the original defect at
 *    `limit: 20`.
 *
 * A share of `1` (or above) is UNBOUNDED rather than "bounded to exactly
 * `limit`" — it has to reproduce the pre-share behaviour byte-for-byte, and
 * that includes keeping a `sourceCaps` entry an operator deliberately set
 * ABOVE the limit.
 */
export const ALL_SOURCES: SourceType[] = ["fact", "session", "doc"];

export function effectiveSourceCaps(
  cfg: GroundedConfig,
  limit: number,
  sources: SourceType[] = ALL_SOURCES,
): Record<SourceType, number> {
  const caps = cfg.recall.sourceCaps;
  const laneShare = cfg.recall.laneShare;
  const multi = sources.length > 1;
  function capFor(st: SourceType): number {
    let cap = Math.max(caps[st], limit);
    const share = laneShare?.[st];
    // `share >= 1` is "unbounded", not "bounded to exactly limit": it has to
    // restore the pre-share behaviour byte-for-byte, including an operator's
    // deliberately-wider `sourceCaps` entry.
    if (multi && share != null && share < 1) {
      cap = Math.min(cap, Math.max(1, Math.ceil(limit * share)));
    }
    return cap;
  }
  return { fact: capFor("fact"), session: capFor("session"), doc: capFor("doc") };
}

/** `cfg` with `recall.sourceCaps` widened by `effectiveSourceCaps`. */
export function withEffectiveSourceCaps(
  cfg: GroundedConfig,
  limit: number,
  sources: SourceType[] = ALL_SOURCES,
): GroundedConfig {
  return {
    ...cfg,
    recall: { ...cfg.recall, sourceCaps: effectiveSourceCaps(cfg, limit, sources) },
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
 * adapters.
 *
 * The order is CONFIGURABLE (`recall.tieBreakOrder`) and now leads with docs.
 * It used to be fact → session → doc, copied from `orderResults`; that was a
 * third place — after the pinned/importance boosts and after the unbounded
 * lane cap — where the fact lane won by construction rather than by relevance.
 * Docs are the guidance that pilots project work; facts are guardrails. On an
 * EXACT tie, prefer the doc. `orderResults` keeps the old sectioned order and
 * stays impact-only.
 */
export const DEFAULT_TIE_BREAK_ORDER: SourceType[] = ["doc", "fact", "session"];

export function rankFlat(
  items: FusedItem[],
  meta: Map<string, CandidateMeta>,
  tieBreakOrder: SourceType[] = DEFAULT_TIE_BREAK_ORDER,
): FusedItem[] {
  const order = tieBreakOrder.length > 0 ? tieBreakOrder : DEFAULT_TIE_BREAK_ORDER;
  function tier(it: FusedItem): number {
    // an archived doc is ALWAYS last, whatever the configured order says.
    if (it.sourceType === "doc") {
      const m = meta.get(`doc:${it.id}`);
      if (m?.active === false) return order.length + 1;
    }
    const i = order.indexOf(it.sourceType);
    return i === -1 ? order.length : i;
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
 * sources a scope filter actually applied to.
 *
 * TWO filters, deliberately reported through ONE shape with two arrays.
 * `declared` is the DOC-lane set (`RecallOptions.scopes`). `factScopes` is the
 * FACT-lane set (`recallFactScopes`) — a different axis that happens to live
 * on a same-named column, so folding both into `declared` would replace a
 * silent lie with a loud one. `appliedTo` names every source that was actually
 * filtered; `exempt` the rest. `factScopes` is absent when the fact lane was
 * not narrowed, which is also when `"fact"` stays in `exempt`.
 */
export function scopeFilterMeta(
  sources: SourceType[],
  declared: string[],
  explicit: boolean,
  factScopes: string[] | null = null,
): NonNullable<import("../contract.js").DeliveryMeta["scopeFilter"]> {
  const factFiltered = factScopes !== null && sources.includes("fact");
  const applies = (s: SourceType) => s === "doc" || (s === "fact" && factFiltered);
  const out: NonNullable<import("../contract.js").DeliveryMeta["scopeFilter"]> = {
    declared: [...declared],
    defaulted: !explicit,
    appliedTo: sources.filter(applies),
    exempt: sources.filter((s) => !applies(s)),
  };
  if (factFiltered) out.factScopes = [...factScopes];
  return out;
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
