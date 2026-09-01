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
