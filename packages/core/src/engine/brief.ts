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
import { defaultConfig } from "../config.js";

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
 * truncates within its own slice — no lane can consume another's. This is
 * the char-per-token approximation used throughout: no BPE dependency, the
 * engine has no tokenizer and never will for this purpose.
 */
const CHARS_PER_TOK = 4;

/**
 * Static preamble/maps text (`=== STARTUP CONTEXT ===` header + startupNote +
 * the VISION apply note) budget, for parity with Doctrine 3's reserve table.
 * This is fixed text with nothing to truncate, so it is deliberately NOT a
 * config key (unlike `brief.reserve.{vision,facts,sessions}`) — it enforces
 * nothing and exists purely as documented bookkeeping.
 */
export const PREAMBLE_RESERVE_TOK = 200;

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
 */
function truncateToReserve<T>(
  items: T[],
  availableFromStore: number,
  reserveTok: number,
  renderLine: (item: T) => string,
  typedId: (item: T) => TypedId,
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
    if (used + cost > budget) {
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
): FactsReserveResult {
  const budget = reserveTok * CHARS_PER_TOK;
  const indexBudget = FACTS_INDEX_MAX_TOK * CHARS_PER_TOK;

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
 * Index-tier budget, in the same tokens-as-chars÷4 unit as `brief.reserve.*`.
 * Facts that overflow the full-text reserve still get a shot at a cheap
 * index line (see `renderFactIndexLine`) up to this cap; anything beyond it
 * is truly dropped. A module constant, not a config key — the operator asked
 * for less surface area, not more, and this tier is meant to be cheap and
 * fixed, not tuned per deployment.
 */
const FACTS_INDEX_MAX_TOK = 300;

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
 * without a backfill. Lives here, not in the adapters. */
function visionInjectedText(v: Vision): string {
  return (v.summary ?? v.details).trim();
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

  return {
    global: globalText,
    project: projectText,
    meta: {
      returned: returnedRows,
      available: availableRows,
      truncated,
      limit: null,
      chars: { returned: total, available: availableChars },
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
  const factsReserve = truncateFactsToReserve(
    applyCategoryFloors(parts.facts, cfg.brief.factCategoryFloors ?? {}),
    parts.factsAvailable,
    cfg.brief.reserve.facts,
  );
  const sessionsReserve = truncateToReserve(
    parts.recentSessions,
    parts.recentSessionsAvailable,
    cfg.brief.reserve.sessions,
    (s: Session) => renderSessionLine(s, opts.timezone),
    (s) => `session:${s.id}` as TypedId,
  );
  const vision = parts.vision ?? { global: null, project: null };
  const visionSection = truncateVisionSection(vision.global, vision.project, cfg.brief.reserve.vision);

  const droppedItems: TypedId[] = [...factsReserve.droppedIds, ...sessionsReserve.droppedIds];

  const result: BriefResult = {
    startupNote: STARTUP_NOTE,
    vision,
    recentSessions: sessionsReserve.kept,
    facts: factsReserve.kept,
    relatedDocs: parts.relatedDocs,
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
function droppedNote(kind: string, ids: TypedId[]): string {
  const shown = ids.slice(0, MAX_NAMED_DROPPED);
  const rest = ids.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : "";
  return `… ${ids.length} more ${kind} in scope, not shown this budget — ground_get any of: ${shown.join(", ")}${suffix}`;
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
    const visionSection = truncateVisionSection(gv, pv, cfg.brief.reserve.vision);
    const scopeBits = [gv ? "global" : null, pv ? pv.scope : null].filter(Boolean);
    lines.push(`=== VISION (${scopeBits.join(" · ")}) ===`);
    if (gv && visionSection.global !== null) lines.push(visionSection.global);
    if (pv && visionSection.project !== null) {
      if (gv) lines.push(`--- ${pv.scope} ---`);
      lines.push(visionSection.project);
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
  if (brief.meta.sessions.truncated && sessionDropped.length > 0) {
    lines.push(droppedNote("sessions", sessionDropped));
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
    for (const f of indexedFacts) {
      lines.push(renderFactIndexLine(f));
    }
  }
  if (brief.meta.facts.truncated && factDropped.length > 0) {
    lines.push(droppedNote("facts", factDropped));
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
