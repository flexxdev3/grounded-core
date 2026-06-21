import type { GroundedConfig, SourceType, MatchedBy } from "../contract.js";

/** A single lane hit: an item id and its 0-based rank within that lane. */
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
 * Final cross-source ordering: facts → recent sessions → active docs →
 * historical docs. Within a tier, by score descending.
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
