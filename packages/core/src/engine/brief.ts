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

function renderFactLine(f: Fact): string {
  const pin = f.pinned ? "* " : "- ";
  const detail = f.detail && f.detail.trim() ? ` — ${collapseWhitespace(f.detail)}` : "";
  return `${pin}${f.fact}${detail} (fact:${f.id})`;
}

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
function renderSessionLine(s: Session): string {
  const when = s.createdAt ? s.createdAt.slice(0, 10) : "";
  const proj = s.project ? ` [${s.project}]` : "";
  return `- ${when}${proj} ${s.summary} (session:${s.id})`;
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
 * `meta` here is measured in CHARS, not items: `returned` is the
 * post-truncation combined char count, `available` is the pre-truncation
 * combined char count. Do not read `available: 1800` as "1800 records" —
 * it's characters. Vision never appears in `droppedItems`: there is no
 * vision arm in `SourceType`/`TypedId`.
 */
function truncateVisionSection(
  gv: Vision | null,
  pv: Vision | null,
  reserveTok: number,
): VisionSection {
  const budget = reserveTok * CHARS_PER_TOK;
  let globalText = gv ? visionInjectedText(gv) : null;
  let projectText = pv ? visionInjectedText(pv) : null;
  const available = (globalText?.length ?? 0) + (projectText?.length ?? 0);
  let truncated = false;

  let total = available;
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

  return {
    global: globalText,
    project: projectText,
    meta: {
      returned: total,
      available,
      truncated,
      limit: null,
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
  const factsReserve = truncateToReserve(
    parts.facts,
    parts.factsAvailable,
    cfg.brief.reserve.facts,
    renderFactLine,
    (f) => `fact:${f.id}` as TypedId,
  );
  const sessionsReserve = truncateToReserve(
    parts.recentSessions,
    parts.recentSessionsAvailable,
    cfg.brief.reserve.sessions,
    renderSessionLine,
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
  };
  if (opts.format !== "json") {
    result.text = renderMarkdown(result, opts, cfg);
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

  lines.push("=== MOST RECENT WORK (newest first) ===");
  if (brief.recentSessions.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of brief.recentSessions) {
      lines.push(renderSessionLine(s));
    }
  }
  if (brief.meta.sessions.truncated && sessionDropped.length > 0) {
    lines.push(droppedNote("sessions", sessionDropped));
  }
  lines.push("");

  lines.push(`=== DYNAMIC FACTS (curated · scope: ${factsScopeLabel(opts)}) ===`);
  if (brief.facts.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of brief.facts) {
      lines.push(renderFactLine(f));
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
