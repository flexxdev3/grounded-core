import type {
  BriefOptions,
  BriefResult,
  DeliveryMeta,
  Fact,
  GroundedConfig,
  RecallResult,
  Session,
  TypedId,
  Vision,
} from "../contract.js";
import {
  CHARS_PER_TOK,
  LANE_BUDGETS,
  defaultConfig,
  resolveBudget,
  resolveLaneBudget,
} from "../config.js";
import type { ResolvedLaneBudget } from "../config.js";

const STARTUP_NOTE =
  "Lead from MOST RECENT WORK below. The DYNAMIC FACTS under it are curated standing knowledge — treat as authoritative.";

export function startupNote(): string {
  return STARTUP_NOTE;
}

/**
 * The scope set a brief loads facts from: an explicit `factScopes` override, or
 * the default `global` + `agent:<agent>` + `project:<project>` + `machine:<machine>`
 * derivation. This is what keeps off-agent/off-machine scopes (e.g. another project's
 * or another box's facts) out of startup — a fact scoped `machine:arch1` only surfaces
 * on arch1.
 */
export function deriveFactScopes(opts: BriefOptions): string[] {
  if (opts.factScopes && opts.factScopes.length > 0) {
    return [...new Set(opts.factScopes)];
  }
  const scopes = ["global"];
  if (opts.agent) scopes.push(`agent:${opts.agent}`);
  if (opts.project) scopes.push(`project:${opts.project}`);
  if (opts.machine) scopes.push(`machine:${opts.machine}`);
  return [...new Set(scopes)];
}

/**
 * The doc-lane scope set the brief's related-docs recall call reads from.
 * Explicit-only — unlike `deriveFactScopes`, there is no agent/project/machine
 * derivation. Returns the deduped `opts.docScopes` when non-empty, else the
 * default `['global']`.
 */
export function deriveDocScopes(opts: BriefOptions): string[] {
  if (opts.docScopes && opts.docScopes.length > 0) {
    return [...new Set(opts.docScopes)];
  }
  return ["global"];
}

/** Distinct FILES the related-docs lane delivers. This is the number the lane
 *  has always meant; before `dedupeDocsByPath` it was a count of CHUNKS, which
 *  is why a 5-slot lane could carry 3 files. */
export const RELATED_DOCS_LIMIT = 5;

/**
 * First fetch size for the lane. The over-fetch is required, not defensive:
 * recall ranks CHUNKS, so asking for exactly `RELATED_DOCS_LIMIT` can hand the
 * engine five chunks of two files and the dedupe below then delivers two docs —
 * trading the duplicate waste for an empty-slot waste. 4x is sized off the
 * measured brief (5 chunk slots held 3 files, i.e. one file contributed 3
 * chunks); 20 rows of a doc-only recall is cheap and the discarded rows never
 * reach a budgeted lane.
 */
export const RELATED_DOCS_FETCH = RELATED_DOCS_LIMIT * 4;

/**
 * Second and last fetch size, used only when the first one failed to fill the
 * lane. No fixed over-fetch can GUARANTEE five distinct files — a corpus of a
 * few long, near-identical documents puts 20 chunks of two files at the top —
 * so `fillRelatedDocs` widens once rather than silently under-delivering. 200
 * is the same ceiling the API enforces on any retrieval `limit`.
 */
const RELATED_DOCS_FETCH_MAX = 200;

/**
 * Fill the related-docs lane with `limit` DISTINCT files.
 *
 * `fetchDocs(n)` is the caller's doc-only `recall()` — the adapters pass a
 * one-line lambda, so the escalation and the dedupe live here (one copy, and
 * the copy the shared brief suite covers) instead of twice in storage.
 *
 * Widens at most once, and only when it would change the answer: the second
 * fetch costs another `recall()` (including a query embedding), which is worth
 * paying only after the cheap fetch has demonstrably failed to fill the lane.
 * Stops early when the first fetch came back short — fewer rows than requested
 * means the lane is exhausted and a wider ask cannot find a sixth file.
 */
export async function fillRelatedDocs(
  fetchDocs: (limit: number) => Promise<RecallResult[]>,
  limit: number = RELATED_DOCS_LIMIT,
): Promise<RecallResult[]> {
  let kept: RecallResult[] = [];
  for (const step of [RELATED_DOCS_FETCH, RELATED_DOCS_FETCH_MAX]) {
    const hits = await fetchDocs(step);
    kept = dedupeDocsByPath(hits, limit);
    if (kept.length >= limit) break;
    if (hits.length < step) break;
  }
  return kept;
}

/**
 * Collapse chunk-level recall hits to one row per FILE, best chunk wins.
 *
 * Measured: a live brief returned 5 relatedDocs slots holding 3 unique files —
 * `claude/CLAUDE.md` x2 and `how-tos/how-to-grounded-project-identity.md` x2 —
 * ~40% of the doc budget spent re-citing files the reader already had. `recall()`
 * is right to return chunks (`/recall` keeps that behavior untouched); the brief
 * is a fixed-slot delivery surface, and a slot spent on a second chunk of a file
 * already cited buys nothing that `ground_get` would not.
 *
 * Deduped HERE, in the engine, not in the adapters: both adapters would
 * otherwise need the same pass, and only the engine's copy is covered by the
 * shared brief suite. Falls back to `typedId` when `path` is null so two
 * pathless rows can never be folded into one.
 */
export function dedupeDocsByPath(
  docs: RecallResult[],
  limit: number = RELATED_DOCS_LIMIT,
): RecallResult[] {
  const best = new Map<string, RecallResult>();
  for (const d of docs) {
    const key = d.path ?? d.typedId;
    const seen = best.get(key);
    // Explicitly keep the higher score rather than trusting arrival order —
    // callers hand this list straight from recall (score-desc today), but the
    // "best chunk per file" guarantee must not depend on that.
    if (!seen || d.score > seen.score) best.set(key, d);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The fixed line that makes vision applied, not just present. */
const VISION_APPLY_NOTE =
  "Apply this: flag any plan, play, or design that conflicts with the vision before executing it.";

/** Collapse runs of whitespace (incl. newlines) to a single space, mirroring the
 * `gsub("\\s+"; " ")` normalization the shell brief hook applies to body text. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Doctrine 3: the startup window is budgeted by RESERVATION, not drop order.
 * Each lane (vision/facts/sessions) gets a fixed share of the window and
 * truncates within its own slice — no lane can consume another's.
 *
 * The reserve table itself, and every cap derived from it, now lives in
 * config.ts (`LANE_BUDGETS` / `resolveBudget`). This file CONSUMES the resolved
 * table; it never states a lane size of its own. `CHARS_PER_TOK` is imported
 * from the same place for the same reason.
 */

/**
 * The vision lane's WRITE cap, derived from the same reserve that budgets its
 * READ. Vision is the one lane the brief truncates as text rather than dropping
 * rows, so an over-long row was never rejected — it was silently cut at
 * delivery, and the author never learned. Deriving the cap here, from the
 * reserve, is what keeps the two from drifting: raising `brief.reserve.vision`
 * raises what a writer may store, and nothing else has to change.
 *
 * Retained as its own function because MCP's `ground_vision_set` calls it
 * directly; it is now the vision arm of the general `laneWriteVerdict` below.
 */
export function visionCapChars(reserveTok: number): number {
  return reserveTok * CHARS_PER_TOK;
}

/**
 * A write-side budget verdict for ONE stored field on ONE lane. Two tiers,
 * both derived from the same lane record, never restated:
 *
 *   > `rowCapChars`  — WARNING. The row stores, but it costs more than its
 *                      fair share of the lane (`laneCap / rows`) and will
 *                      crowd a neighbour out of the brief.
 *   > `laneCapChars` — ERROR (HTTP 400). One row consuming the ENTIRE lane is
 *                      not a tuning question; nothing else in that lane can be
 *                      delivered alongside it.
 *
 * On vision, `rows: 1` collapses the two tiers onto the same number, which is
 * why vision has always been a hard 400 at 1600 chars and stays one.
 *
 * `bodyCapChars` governs a field the brief never renders (`session.details`).
 * It has no warn tier — the brief does not budget it, so there is no fair
 * share to exceed; there is only the ceiling past which the lane stops being a
 * work log and becomes a document dump.
 */
export interface LaneWriteVerdict {
  error?: string;
  warning?: string;
}

export function laneWriteVerdict(
  budget: ResolvedLaneBudget,
  field: string,
  text: string | null | undefined,
  kind: "brief" | "body" = "brief",
): LaneWriteVerdict {
  const chars = text ? text.length : 0;
  if (kind === "body") {
    const cap = budget.bodyCapChars;
    if (cap === null || chars <= cap) return {};
    return {
      error:
        `"${field}" is ${chars} chars, over the ${cap}-char ${budget.lane} body cap ` +
        `(${budget.reserveTok}-token reserve x ${CHARS_PER_TOK} x ${cap / budget.laneCapChars}). ` +
        `Trim ${chars - cap} chars, or split the log across entries.`,
    };
  }
  if (chars > budget.laneCapChars) {
    return {
      error:
        `"${field}" is ${chars} chars, over the ${budget.laneCapChars}-char ${budget.lane} lane cap ` +
        `(the whole lane's startup budget: ${budget.reserveTok} tokens x ${CHARS_PER_TOK}). ` +
        `A single row this size leaves no room for any other ${budget.lane} row. ` +
        `Trim ${chars - budget.laneCapChars} chars.`,
    };
  }
  if (chars > budget.rowCapChars) {
    return {
      warning:
        `"${field}" is ${chars} chars, over the ${budget.rowCapChars}-char per-row share of the ` +
        `${budget.lane} lane (${budget.laneCapChars} chars / ${budget.rows} rows) — it will crowd ` +
        `other ${budget.lane} out of the brief`,
    };
  }
  return {};
}

/**
 * The shared over-cap verdict for VISION. Returns the operator-facing message,
 * or null when the text fits. Public for the same reason `computeDeliveryRank`
 * is: API and MCP both write vision, and a surface that reimplements this can
 * disagree with the engine about what fits.
 *
 * Kept as its own function rather than folded into `laneWriteVerdict` because
 * its message teaches the vision lane's editorial rule (objectives and next
 * steps, not history). It still states no number of its own — `capChars` comes
 * from the same resolved budget table, via `visionCapChars`.
 */
export function visionCapError(details: string, capChars: number): string | null {
  if (details.length <= capChars) return null;
  return (
    `details is ${details.length} chars, over the ${capChars}-char vision cap. ` +
    `Vision carries objectives and committed next steps only -- history belongs in ` +
    `sessions, open defects in a HANDOFF doc. Trim ${details.length - capChars} chars.`
  );
}

/**
 * Static preamble/maps text (`=== STARTUP CONTEXT ===` header + startupNote +
 * the VISION apply note) budget, for parity with Doctrine 3's reserve table.
 * This is fixed text with nothing to truncate, so it is deliberately NOT a
 * config key (unlike `brief.reserve.{vision,facts,sessions}`) — it enforces
 * nothing and exists purely as documented bookkeeping.
 */
export const PREAMBLE_RESERVE_TOK = 200;

/**
 * ACCOUNTING CONTRACT — what "a truncated lane accounts for what it withheld"
 * means, per lane. There are exactly three shapes that account can take, and
 * which one a lane uses is a property of the lane, not a per-call choice:
 *
 * 1. NAMED — the row reached this engine and was then cut, either by the lane's
 *    char reserve or by the caller's row cap (`BriefOptions.recentSessions`).
 *    Its typed id goes in `droppedItems` and `renderMarkdown` names it in the
 *    lane's trailing note. Facts and sessions both work this way. This is the
 *    only fully honest form and the one every drop should land in.
 *
 * 2. COUNTED — the row matched in the store but never reached this engine, so
 *    there is no id to name: the adapter's pre-limit `available` exceeds what
 *    arrived in `BriefParts`. The engine cannot invent ids it was never given,
 *    but it must not stay SILENT either — the note reports the unnamed
 *    remainder and points at the listing tool that recovers it. Every COUNTED
 *    row is a defect in the CALLER's fetch window, not in this file: a lane
 *    fetched narrower than its own reserve can never name its own drops. The
 *    facts lane fetches at 200 for exactly this reason. The sessions lane is
 *    fetched at `recentSessions ?? 8` in both storage adapters, which is why a
 *    live brief can report `sessions {returned: 8, available: 50, truncated:
 *    true}` with an empty `droppedItems` — 42 COUNTED rows. Widening that
 *    fetch moves them into case 1; the row cap below then keeps the rendered
 *    count at the caller's requested 8.
 *
 * 3. EXEMPT — vision only. Vision has no arm in `SourceType`/`TypedId`, so it
 *    has no id to place in `droppedItems` by construction, and it truncates
 *    TEXT inside kept rows instead of dropping rows. Its account is
 *    `meta.vision.chars` plus a rendered pointer at `ground_vision_get`, which
 *    returns the record untruncated. This is deliberate and is documented on
 *    `BriefResult.meta` in contract.ts — it is NOT a case-2 defect. Any prose
 *    claiming `droppedItems` names everything a brief withheld is overclaiming;
 *    the true claim is scoped to facts and sessions.
 */

/**
 * Rows the sessions lane renders when the caller doesn't ask for a specific
 * count — the same default both storage adapters apply to their own fetch.
 * Enforced HERE as well as at the fetch, so that widening the adapters' fetch
 * (case 2 above) names the surplus in `droppedItems` instead of growing the
 * rendered list.
 */
export const DEFAULT_RECENT_SESSIONS = LANE_BUDGETS.sessions.rows;

export interface BriefParts {
  vision?: { global: Vision | null; project: Vision | null };
  recentSessions: Session[];
  facts: Fact[];
  relatedDocs: RecallResult[];
  /** The true pre-reserve match count for facts, sourced from the adapter's
   * `factsList(...).meta.available` (fetched at limit 200, not the reserve's
   * truncated count) — this is what lets `truncateToReserve` report an honest
   * `available` even when the reserve itself dropped rows before this point. */
  factsAvailable: number;
  /** Same idea as `factsAvailable`, for the recent-sessions lane. */
  recentSessionsAvailable: number;
}

interface ReserveResult<T> {
  kept: T[];
  droppedIds: TypedId[];
  meta: DeliveryMeta;
}

/**
 * Truncate `items` (already in significance order — pinned/importance/recency
 * for facts, newest-first for sessions) to fit within `reserveTok * CHARS_PER_TOK`
 * characters, measured with the SAME string the renderer will emit for each
 * item (`renderLine`) so the budget reflects real cost, not an approximation.
 *
 * Items are consumed strictly in the order given. Once the budget is
 * exceeded, everything after is dropped IN ORDER — never cherry-picked, even
 * if a later, shorter item would technically still fit.
 *
 * Guard: the first item is never dropped, even if it alone exceeds the
 * reserve. A single long pinned fact must not produce an empty facts
 * section — better to blow the budget slightly than deliver nothing.
 *
 * `maxRows` is an optional ROW cap applied alongside the char budget —
 * whichever binds first. It exists so a caller's requested row count is
 * enforced in the one place that can still NAME what it cut (case 1 of the
 * accounting contract above); a row cap applied at the fetch instead produces
 * unnameable case-2 rows.
 */
function truncateToReserve<T>(
  items: T[],
  availableFromStore: number,
  reserveTok: number,
  renderLine: (item: T) => string,
  typedId: (item: T) => TypedId,
  maxRows?: number,
): ReserveResult<T> {
  const budget = reserveTok * CHARS_PER_TOK;
  const kept: T[] = [];
  const droppedIds: TypedId[] = [];
  let used = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const cost = renderLine(item).length;
    if (i === 0) {
      // Never drop the first item, however large.
      kept.push(item);
      used += cost;
      continue;
    }
    const capBinds = maxRows !== undefined && kept.length >= maxRows;
    if (capBinds || used + cost > budget) {
      for (let j = i; j < items.length; j++) droppedIds.push(typedId(items[j]!));
      break;
    }
    kept.push(item);
    used += cost;
  }

  // `available` is a real computed quantity, never derived from data.length:
  // take the larger of what the store reported pre-reserve and what actually
  // arrived here (the store's count can only ever be a floor on what's truly
  // in scope, per the same honesty rule recall() follows for lane saturation).
  const available = Math.max(availableFromStore, items.length);
  const truncated = kept.length < items.length || available > items.length;

  return {
    kept,
    droppedIds,
    meta: {
      returned: kept.length,
      available,
      truncated,
      // A reserve is a char budget, not a row limit — there is no single
      // number of rows this lane was "limited to", so `limit` stays null.
      limit: null,
    },
  };
}

interface FactsReserveResult {
  kept: Fact[];
  droppedIds: TypedId[];
  indexedIds: TypedId[];
  /** Same rows as `indexedIds`, kept as full `Fact` records purely so
   * `renderMarkdown` can render their index lines — `BriefResult` itself only
   * ever exposes the id form (`indexedItems`). */
  indexedFacts: Fact[];
  meta: DeliveryMeta;
}

/**
 * Facts-lane counterpart to `truncateToReserve`, with two behaviors sessions
 * don't have:
 *
 * 1. `pinned` is a delivery GUARANTEE, not a rank boost: every pinned fact
 *    (plus, as before, `items[0]` regardless of pinned) renders in FULL TEXT
 *    no matter the budget. Because a pinned fact can in principle sit
 *    anywhere in `facts` (already-significance-ordered, but pinned isn't
 *    assumed contiguous), this does a full pass rather than stopping at the
 *    first overflow — unlike the generic `truncateToReserve`.
 * 2. Facts that don't survive the full-text cut get a second chance at a
 *    cheap INDEX LINE (`renderFactIndexLine`) inside their own, smaller
 *    `FACTS_INDEX_MAX_TOK` budget, consumed in the same order they overflowed
 *    in. Only what still doesn't fit THAT budget is truly dropped.
 *
 * `droppedItems`'s existing meaning is preserved exactly: it names only what
 * is truly absent from `brief.text`. Indexed facts are reported separately
 * via `indexedIds` (surfaced as `BriefResult.indexedItems`) — present in the
 * rendered text, just compressed.
 */
function truncateFactsToReserve(
  facts: Fact[],
  availableFromStore: number,
  reserveTok: number,
  indexTok: number = FACTS_INDEX_MAX_TOK,
): FactsReserveResult {
  const budget = reserveTok * CHARS_PER_TOK;
  const indexBudget = indexTok * CHARS_PER_TOK;

  const kept: Fact[] = [];
  const overflow: Fact[] = [];
  let used = 0;
  // Once a non-pinned item overflows, every later non-pinned item overflows
  // too — the "never cherry-picked" rule `truncateToReserve` documents.
  // Without this flag a full scan (needed so a pinned item further down the
  // list still gets found) would let a later, SHORTER non-pinned item slip
  // into room a dropped earlier one didn't fit, which is exactly the
  // cherry-picking the reserve contract forbids.
  let overflowStarted = false;

  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    const cost = renderFactLine(f).length;
    const mustKeep = i === 0 || f.pinned;
    if (mustKeep) {
      kept.push(f);
      used += cost;
      continue;
    }
    if (overflowStarted || used + cost > budget) {
      overflowStarted = true;
      overflow.push(f);
      continue;
    }
    kept.push(f);
    used += cost;
  }

  // Consume the index budget in the same order items overflowed, IN ORDER —
  // once it's exceeded, everything after is truly dropped, mirroring
  // `truncateToReserve`'s own in-order cutoff rule.
  let indexUsed = 0;
  let cutIndex = overflow.length;
  for (let i = 0; i < overflow.length; i++) {
    const cost = renderFactIndexLine(overflow[i]!).length;
    if (indexUsed + cost > indexBudget) {
      cutIndex = i;
      break;
    }
    indexUsed += cost;
  }
  const indexed = overflow.slice(0, cutIndex);
  const trulyDropped = overflow.slice(cutIndex);

  const available = Math.max(availableFromStore, facts.length);
  const budgetBlownByGuarantee = used > budget;
  const truncated = kept.length < facts.length || available > facts.length || budgetBlownByGuarantee;

  const meta: DeliveryMeta = {
    returned: kept.length,
    available,
    truncated,
    limit: null,
    ...(indexed.length > 0 ? { indexed: indexed.length } : {}),
  };

  return {
    kept,
    droppedIds: trulyDropped.map((f) => `fact:${f.id}` as TypedId),
    indexedIds: indexed.map((f) => `fact:${f.id}` as TypedId),
    indexedFacts: indexed,
    meta,
  };
}

/**
 * The pinned facts' write-time delivery-warning input: how many rendered
 * chars the pinned set alone costs against the facts reserve. Lives here
 * (not delivery.ts) because it needs `renderFactLine`/`CHARS_PER_TOK`, the
 * same render+budget primitives the reserve itself uses — callers pass the
 * result straight into `computeDeliveryRank`'s `pinnedReserve` param.
 */
export function pinnedFactsReserveStatus(
  facts: Fact[],
  reserveTok: number,
): { renderedChars: number; reserveChars: number } {
  const renderedChars = facts
    .filter((f) => f.pinned)
    .reduce((sum, f) => sum + renderFactLine(f).length, 0);
  return { renderedChars, reserveChars: reserveTok * CHARS_PER_TOK };
}

/**
 * Per-category floor pre-pass (runs before `truncateToReserve`). `facts` is
 * already in significance order; this reorders — never adds/removes/dedups —
 * so that the first `n` facts of each floored category are guaranteed to
 * survive the reserve's strict in-order cutoff, even if a high-volume
 * unfloored category would otherwise fill the whole budget first.
 *
 * Floored facts keep their relative order, followed by everyone else in
 * their relative order. A category missing from `facts`, or a floor bigger
 * than what's available, is a no-op for that category — never throws.
 */
export function applyCategoryFloors(facts: Fact[], floors: Record<string, number>): Fact[] {
  if (!floors || Object.keys(floors).length === 0) return [...facts];

  const takenPerCategory = new Map<string, number>();
  const floored: Fact[] = [];
  const flooredIndices = new Set<number>();

  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    const limit = floors[f.category];
    if (!limit || limit <= 0) continue;
    const taken = takenPerCategory.get(f.category) ?? 0;
    if (taken >= limit) continue;
    takenPerCategory.set(f.category, taken + 1);
    floored.push(f);
    flooredIndices.add(i);
  }

  const rest = facts.filter((_, i) => !flooredIndices.has(i));
  return [...floored, ...rest];
}

/**
 * The chars of a fact that the facts lane's reserve actually pays for: the
 * author-controlled payload of `renderFactLine`, minus the wrapper the writer
 * does not control (the `- `/`* ` marker and the ` (fact:NN)` citation — the
 * id does not even exist yet on a POST). Exported so the write guard and the
 * post-write warning measure the SAME string, and so neither has to know how a
 * fact line is assembled.
 */
export function factBudgetText(fact: string, detail?: string | null): string {
  const d = detail && detail.trim() ? ` — ${collapseWhitespace(detail)}` : "";
  return `${fact}${d}`;
}

function renderFactLine(f: Fact): string {
  const pin = f.pinned ? "* " : "- ";
  const detail = f.detail && f.detail.trim() ? ` — ${collapseWhitespace(f.detail)}` : "";
  return `${pin}${f.fact}${detail} (fact:${f.id})`;
}

/**
 * Compressed form of a fact that didn't fit the facts reserve's full-text
 * budget: `topicKey — detail (fact:NN)`. `detail` on a fact IS its trigger
 * clause (e.g. "when about to stop, remove, delete or rename a container"),
 * so this line still tells the agent WHEN the fact matters, just not what it
 * says — enough to justify a `ground_get fact:NN` follow-up instead of the
 * fact vanishing outright. Falls back to `fact` when `topicKey` is unset
 * (older rows predate the column) and to a fixed placeholder when `detail`
 * is unset, so the line is never empty.
 */
function renderFactIndexLine(f: Fact): string {
  const topic = f.topicKey && f.topicKey.trim() ? f.topicKey : f.fact;
  const detail = f.detail && f.detail.trim() ? collapseWhitespace(f.detail) : "(no trigger detail)";
  return `${topic} — ${detail} (fact:${f.id})`;
}

/**
 * Index-tier budget, in the same tokens-as-chars÷4 unit as the lane reserve.
 * Facts that overflow the full-text reserve still get a shot at a cheap index
 * line (see `renderFactIndexLine`) up to this cap; anything beyond it is truly
 * dropped.
 *
 * Read from the budget table (`LANE_BUDGETS.facts.indexTok`), not typed here:
 * the table is the one place a lane size is stated. It is an absolute token
 * budget rather than a fraction of the lane, because a tier whose job is to
 * catch what a small lane spilled must not shrink along with the lane.
 */
const FACTS_INDEX_MAX_TOK = LANE_BUDGETS.facts.indexTok!;

/**
 * Sessions render SUMMARY ONLY in the brief. `details` is a full session log —
 * eight of them cost ~7k tokens, 3.5x the entire startup budget, and the length
 * is unbounded by construction. Progressive disclosure is the product's own
 * model for exactly this: recall cards carry a 200-char snippet and `ground_get`
 * hydrates. A budgeted startup lane is the last place to inline a full body.
 *
 * Contrast `renderFactLine`, which DOES inline `fact.detail` — a fact's detail
 * is a single short retrieval trigger, not a document. The asymmetry is the
 * point: short field inline, long field behind an id.
 */
function renderSessionLine(s: Session, timezone?: string): string {
  const when = s.createdAt ? formatSessionDate(s.createdAt, timezone) : "";
  const proj = s.project ? ` [${s.project}]` : "";
  return `- ${when}${proj} ${s.summary} (session:${s.id})`;
}

/**
 * The stored `createdAt` is UTC; this is the ONE place a brief turns it into a
 * date a human reads. Without a `timezone` it stays a plain `slice(0, 10)` —
 * byte-identical to every brief rendered before this option existed.
 *
 * `sv-SE` is not decoration: it is the locale whose short date format is already
 * `YYYY-MM-DD`, so the zone conversion lands in the shape the line has always
 * had without reassembling parts by hand.
 *
 * An unparseable date or unknown zone falls back to the UTC slice rather than
 * throwing. A brief is startup context — degrading one date beats failing the
 * whole assembly. The API validates the zone up front so a typo is a 400 there,
 * not a silent UTC render here.
 */
function formatSessionDate(iso: string, timezone?: string): string {
  if (!timezone) return iso.slice(0, 10);
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

/** The short form injected for a vision row: `summary`, falling back to
 * truncated `details` when `summary` is null — the fallback that lets
 * pre-split rows (written before the `summary` column existed) keep working
 * without a backfill. Lives here, not in the adapters.
 *
 * SUPPRESSION TRAP (documented, not silent): when `summary` is set it REPLACES
 * `details` in the brief — setting a summary on a row whose body was being
 * injected blanks that body at SessionStart. It is deliberately not additive
 * (a row would then cost summary + details against a lane budget sized for
 * one of them), and the behavior is asserted by the shared store suite. What
 * changed is that it is no longer invisible: `visionSuppressedDetailChars`
 * feeds `meta.vision.rows[].suppressedDetailChars` and `renderMarkdown` emits
 * a line naming the chars that did not reach the brief and the tool that
 * returns them. */
function visionInjectedText(v: Vision): string {
  return (v.summary ?? v.details).trim();
}

/** Chars of `details` that the brief did NOT inject because `summary` took
 *  its place. 0 when there is no summary (details IS the injected text). */
function visionSuppressedDetailChars(v: Vision): number {
  return v.summary === null || v.summary === undefined ? 0 : v.details.trim().length;
}

interface VisionSection {
  global: string | null;
  project: string | null;
  meta: DeliveryMeta;
}

/**
 * Vision has no addressable sub-items (unlike facts/sessions), so there is
 * nothing to drop — only text to truncate. Truncates the PROJECT vision
 * first, then GLOBAL if still over budget (global is foundational, per the
 * doctrine's own vision-fix ordering), appending an ellipsis on whichever
 * side was cut.
 *
 * `meta.returned`/`meta.available` are ROWS (0–2: global and/or project), the
 * same unit every other lane uses. The char arithmetic this function actually
 * budgets on lives in `meta.chars`. A row counts as returned only if some of
 * its text survived — a row truncated down to the bare ellipsis is dropped
 * from the count. `truncated` is true when text was cut, even if both rows
 * survived. Vision never appears in `droppedItems`: there is no vision arm in
 * `SourceType`/`TypedId`.
 */
function truncateVisionSection(
  gv: Vision | null,
  pv: Vision | null,
  reserveTok: number,
): VisionSection {
  const budget = reserveTok * CHARS_PER_TOK;
  let globalText = gv ? visionInjectedText(gv) : null;
  let projectText = pv ? visionInjectedText(pv) : null;
  const availableRows = (gv ? 1 : 0) + (pv ? 1 : 0);
  const availableChars = (globalText?.length ?? 0) + (projectText?.length ?? 0);
  let truncated = false;

  let total = availableChars;
  if (total > budget && projectText) {
    const keep = Math.max(0, projectText.length - (total - budget));
    if (keep < projectText.length) {
      projectText = projectText.slice(0, keep) + "…";
      truncated = true;
    }
    total = (globalText?.length ?? 0) + projectText.length;
  }
  if (total > budget && globalText) {
    const keep = Math.max(0, globalText.length - (total - budget));
    if (keep < globalText.length) {
      globalText = globalText.slice(0, keep) + "…";
      truncated = true;
    }
    total = globalText.length + (projectText?.length ?? 0);
  }

  // A row cut all the way down to the bare ellipsis delivered nothing — don't
  // count it as returned.
  const survived = (t: string | null) => t !== null && t !== "…";
  const returnedRows = (survived(globalText) ? 1 : 0) + (survived(projectText) ? 1 : 0);

  // Per-ROW account (case 3 of the accounting contract). Vision cannot enter
  // `droppedItems` — no `SourceType` arm — so this is where a clipped or
  // detail-suppressed row is NAMED rather than only summed into `chars`.
  const rows: NonNullable<DeliveryMeta["rows"]> = [];
  const rowAccount = (v: Vision | null, before: number, after: string | null) => {
    if (!v) return;
    const suppressed = visionSuppressedDetailChars(v);
    rows.push({
      ref: `vision:${v.id}`,
      scope: v.scope,
      chars: { returned: after ? after.length : 0, available: before },
      clipped: (after?.length ?? 0) < before,
      ...(suppressed > 0 ? { suppressedDetailChars: suppressed } : {}),
    });
  };
  rowAccount(gv, gv ? visionInjectedText(gv).length : 0, globalText);
  rowAccount(pv, pv ? visionInjectedText(pv).length : 0, projectText);

  return {
    global: globalText,
    project: projectText,
    meta: {
      returned: returnedRows,
      available: availableRows,
      truncated,
      limit: null,
      chars: { returned: total, available: availableChars },
      ...(rows.length > 0 ? { rows } : {}),
    },
  };
}

/**
 * Orchestrates the reserved-slice budget (Doctrine 3) across all three lanes,
 * then assembles the final `BriefResult` — `meta` per lane and `droppedItems`
 * (facts' dropped ids first, then sessions', in that order).
 *
 * `cfg` defaults to `defaultConfig()` so existing 2-arg callers keep
 * compiling; callers that care about non-default `brief.reserve.*` values
 * (i.e. a real deployment reading `config.toml`) must pass their resolved
 * `GroundedConfig` explicitly.
 */
export function assembleBrief(
  parts: BriefParts,
  opts: BriefOptions,
  cfg: GroundedConfig = defaultConfig(),
): BriefResult {
  // ONE resolved budget table for the whole assembly — the same one the write
  // caps and `GET /health` read. No lane number is typed out in this file.
  const budget = resolveBudget(cfg);
  const factsReserve = truncateFactsToReserve(
    applyCategoryFloors(parts.facts, cfg.brief.factCategoryFloors ?? {}),
    parts.factsAvailable,
    budget.facts.reserveTok,
    budget.facts.indexTok ?? undefined,
  );
  const sessionsReserve = truncateToReserve(
    parts.recentSessions,
    parts.recentSessionsAvailable,
    budget.sessions.reserveTok,
    (s: Session) => renderSessionLine(s, opts.timezone),
    (s) => `session:${s.id}` as TypedId,
    opts.recentSessions ?? budget.sessions.rows,
  );
  const vision = parts.vision ?? { global: null, project: null };
  const visionSection = truncateVisionSection(vision.global, vision.project, budget.vision.reserveTok);

  const droppedItems: TypedId[] = [...factsReserve.droppedIds, ...sessionsReserve.droppedIds];

  const result: BriefResult = {
    startupNote: STARTUP_NOTE,
    vision,
    recentSessions: sessionsReserve.kept,
    facts: factsReserve.kept,
    // One row per file, best chunk, capped at the lane's slot count. The
    // adapters over-fetch (RELATED_DOCS_FETCH) so this still fills all five
    // slots when five distinct files matched.
    relatedDocs: dedupeDocsByPath(parts.relatedDocs),
    meta: {
      vision: visionSection.meta,
      facts: factsReserve.meta,
      sessions: sessionsReserve.meta,
    },
    droppedItems,
    indexedItems: factsReserve.indexedIds,
  };
  if (opts.format !== "json") {
    result.text = renderMarkdown(result, opts, cfg, factsReserve.indexedFacts);
  }
  return result;
}

function factsScopeLabel(opts: BriefOptions): string {
  return deriveFactScopes(opts).join(" + ");
}

/** One short line naming what a lane's reserve dropped, mirroring the
 * stopgap phrasing already live in `grounded-hook.sh`. Kept short — it is
 * paid for out of the same budget it's reporting on. Caps the named ids so a
 * very large drop can't itself blow the lane's remaining room. */
const MAX_NAMED_DROPPED = 8;

/** The listing surface that recovers a lane's UNNAMED remainder — case 2 of
 * the accounting contract, where the rows never reached the engine and so have
 * no id to `ground_get`. */
const LANE_LISTER: Record<string, string> = {
  sessions: "ground_timeline",
  facts: "ground_facts_list",
};

/**
 * `unnamed` is the count of rows this lane withheld but could not name (case
 * 2): `available - returned - indexed - dropped`. It is normally 0. When it
 * isn't, the note still has to fire — a truncated lane that renders NO note
 * because it happens to have no ids to name is the silent-withholding bug this
 * function exists to prevent.
 */
function droppedNote(kind: string, ids: TypedId[], unnamed = 0): string {
  const lister = LANE_LISTER[kind] ?? "the lane's list tool";
  const total = ids.length + unnamed;
  if (ids.length === 0) {
    return `… ${total} more ${kind} in scope, not shown this budget and not individually named — beyond this brief's fetch window, list them with ${lister}`;
  }
  const shown = ids.slice(0, MAX_NAMED_DROPPED);
  const rest = ids.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : "";
  const unnamedSuffix =
    unnamed > 0 ? ` (a further ${unnamed} not named this brief — ${lister} for those)` : "";
  return `… ${total} more ${kind} in scope, not shown this budget — ground_get any of: ${shown.join(", ")}${suffix}${unnamedSuffix}`;
}

/** Rows a lane withheld without naming: what it says it had, minus everything
 * it rendered (full text + index lines) and everything it named as dropped.
 * Clamped at 0 — `available` is a documented floor, so an adapter that
 * under-reports it must never produce a negative "unnamed" count. */
function unnamedCount(meta: DeliveryMeta, namedDropped: number, indexed = 0): number {
  return Math.max(0, meta.available - meta.returned - indexed - namedDropped);
}

export function renderMarkdown(
  brief: BriefResult,
  opts: BriefOptions,
  cfg: GroundedConfig = defaultConfig(),
  /** Full `Fact` records for `brief.indexedItems`, so their index lines can
   * be rendered. Only `assembleBrief` has these on hand (`BriefResult` itself
   * only carries the id form); external callers re-rendering a fetched
   * `BriefResult` won't have index lines to show, which is fine — they can
   * still `ground_get` any id in `indexedItems`. */
  indexedFacts: Fact[] = [],
): string {
  const lines: string[] = [];
  lines.push("=== STARTUP CONTEXT ===");
  lines.push(brief.startupNote);
  lines.push("");

  // Vision: always injected when set, omitted entirely when empty. Truncated
  // to `cfg.brief.reserve.vision` chars — see truncateVisionSection's doc.
  const gv = brief.vision?.global ?? null;
  const pv = brief.vision?.project ?? null;
  if (gv || pv) {
    const visionSection = truncateVisionSection(gv, pv, resolveBudget(cfg).vision.reserveTok);
    const scopeBits = [gv ? "global" : null, pv ? pv.scope : null].filter(Boolean);
    lines.push(`=== VISION (${scopeBits.join(" · ")}) ===`);
    if (gv && visionSection.global !== null) lines.push(visionSection.global);
    if (pv && visionSection.project !== null) {
      if (gv) lines.push(`--- ${pv.scope} ---`);
      lines.push(visionSection.project);
    }
    // Case 3 of the accounting contract: vision cannot appear in
    // `droppedItems` (no `TypedId` arm), so this line IS its account in the
    // text — without it a 19k-char vision cut to 1.8k is marked only by a
    // single trailing ellipsis with no way back to the full record.
    if (visionSection.meta.truncated && visionSection.meta.chars) {
      const { returned, available } = visionSection.meta.chars;
      lines.push(
        `… vision cut to ${returned} of ${available} chars for the startup budget — ground_vision_get returns it in full.`,
      );
    }
    // The suppression trap, made loud: a row with a `summary` injects the
    // summary INSTEAD of `details`, so the body above is not the vision — it
    // is its short form, and the rest never reached this brief. Silent before;
    // one line now, naming the row and the chars withheld.
    for (const row of visionSection.meta.rows ?? []) {
      if (!row.suppressedDetailChars) continue;
      lines.push(
        `… ${row.ref} (${row.scope}) shows its summary; ${row.suppressedDetailChars} chars of details were not injected — ground_vision_get returns them.`,
      );
    }
    lines.push(VISION_APPLY_NOTE);
    lines.push("");
  }

  const factDropped = brief.droppedItems.filter((id) => id.startsWith("fact:"));
  const sessionDropped = brief.droppedItems.filter((id) => id.startsWith("session:"));

  lines.push(
    opts.timezone
      ? `=== MOST RECENT WORK (newest first · ${opts.timezone}) ===`
      : "=== MOST RECENT WORK (newest first) ===",
  );
  if (brief.recentSessions.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of brief.recentSessions) {
      lines.push(renderSessionLine(s, opts.timezone));
    }
  }
  const sessionsUnnamed = unnamedCount(brief.meta.sessions, sessionDropped.length);
  if (brief.meta.sessions.truncated && (sessionDropped.length > 0 || sessionsUnnamed > 0)) {
    lines.push(droppedNote("sessions", sessionDropped, sessionsUnnamed));
  }
  lines.push("");

  lines.push(`=== DYNAMIC FACTS (curated · scope: ${factsScopeLabel(opts)}) ===`);
  if (brief.facts.length === 0 && indexedFacts.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of brief.facts) {
      lines.push(renderFactLine(f));
    }
    // Index tier: facts that didn't fit the full-text budget but did fit the
    // (smaller) index budget render as a compressed line rather than
    // vanishing — see `renderFactIndexLine`/`FACTS_INDEX_MAX_TOK`.
    //
    // LABELLED, not just emitted: an index line looks like a fact line with a
    // terse body, so an unlabelled block reads as "these facts are short"
    // rather than "these facts were compressed to fit". The tier engaging is
    // itself budget information — say so, and say how to get the full text.
    if (indexedFacts.length > 0) {
      lines.push(
        `… ${indexedFacts.length} more fact${indexedFacts.length > 1 ? "s" : ""} compressed to ` +
          `index lines (topic — trigger only) to fit the facts budget — ground_get for the full text:`,
      );
    }
    for (const f of indexedFacts) {
      lines.push(renderFactIndexLine(f));
    }
  }
  // Index-tier facts are NOT withheld (they rendered, compressed), so they are
  // subtracted out before asking what went unnamed.
  const factsUnnamed = unnamedCount(
    brief.meta.facts,
    factDropped.length,
    brief.indexedItems.length,
  );
  if (brief.meta.facts.truncated && (factDropped.length > 0 || factsUnnamed > 0)) {
    lines.push(droppedNote("facts", factDropped, factsUnnamed));
  }

  if (brief.relatedDocs.length > 0) {
    lines.push("");
    lines.push("=== RELATED DOCS ===");
    for (const d of brief.relatedDocs) {
      const snippet = d.snippet && d.snippet.trim() ? ` — ${collapseWhitespace(d.snippet)}` : "";
      lines.push(`- ${d.title}${snippet} (${d.citation})`);
    }
  }

  return lines.join("\n");
}
