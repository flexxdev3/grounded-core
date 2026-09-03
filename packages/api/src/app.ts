import { Hono } from "hono";
import {
  ConfigError,
  EmbedError,
  IngestPathError,
  GroundedError,
  StoreError,
  isValidTimeZone,
} from "@grounded/core/contract";
import type {
  BriefOptions,
  DeliveryRank,
  Fact,
  FactInput,
  FactOrigin,
  FactStatus,
  FactWriteResponse,
  ImpactOptions,
  IngestOptions,
  ListOptions,
  RecallOptions,
  SessionInput,
  SourceType,
  Store,
  TypedId,
  VisionInput,
} from "@grounded/core/contract";
// Narrow subpath, not the barrel: the route layer must not drag openStore and
// its database drivers in just to render a delivery warning.
import {
  LANE_BUDGETS,
  computeDeliveryRank,
  factBudgetText,
  laneWriteVerdict,
  pinnedFactsReserveStatus,
  resolveLaneBudget,
  visionCapChars,
  visionCapError,
} from "@grounded/core/delivery";
import type { ResolvedBudget, ResolvedLaneBudget } from "@grounded/core/delivery";
import { openApiDocument } from "./openapi.js";
import { LLMS_TXT } from "./llms.js";

const SOURCE_TYPES: readonly SourceType[] = ["fact", "session", "doc"];

// Public without a token: liveness, and the agent-facing manual (an agent
// needs it to learn how to call Grounded before it has a token to call with).
const PUBLIC_PATHS = new Set(["/health", "/llms.txt"]);

/**
 * THE BUDGET TABLE, resolved for this app instance.
 *
 * There are no `DEFAULT_*_TOK` constants here any more. A fallback that
 * restates 900 or 400 in the route layer is a second source of truth, and a
 * second source of truth is how the deployed cap, the configured cap, and the
 * documented cap ended up three different numbers. `LANE_BUDGETS` (config.ts)
 * is the only place a lane size is written down; everything below derives.
 *
 * The legacy per-lane options (`typicalFactLimit`, `factsReserveTok`,
 * `visionReserveTok`) still work and still win — they are folded INTO the
 * table rather than living beside it.
 */
function resolveAppBudget(opts: {
  budget?: ResolvedBudget;
  typicalFactLimit?: number;
  factsReserveTok?: number;
  visionReserveTok?: number;
}): ResolvedBudget {
  if (opts.budget) return opts.budget;
  return {
    vision: resolveLaneBudget("vision", {
      ...LANE_BUDGETS.vision,
      reserveTok: opts.visionReserveTok ?? LANE_BUDGETS.vision.reserveTok,
    }),
    facts: resolveLaneBudget("facts", {
      ...LANE_BUDGETS.facts,
      reserveTok: opts.factsReserveTok ?? LANE_BUDGETS.facts.reserveTok,
      rows: opts.typicalFactLimit ?? LANE_BUDGETS.facts.rows,
    }),
    sessions: resolveLaneBudget("sessions", LANE_BUDGETS.sessions),
  };
}

/**
 * Rows `GET /health` inspects per lane when counting over-cap records. A
 * ceiling, not a page size: conformance is a "does anything violate the
 * contract" signal, and scanning an unbounded sessions table (600 rows x up to
 * 12k chars of details, live) on a liveness endpoint would make /health the
 * most expensive route in the API. When the lane has more rows than this the
 * counts are reported with `complete: false` — a floor, never a lie.
 */
const CONFORMANCE_SCAN_LIMIT = 2000;

/** How long a conformance scan is reused. /health is polled by monitors; the
 *  scan is a full-table read. A minute-stale over-cap count still surfaces a
 *  stale deploy or a drifted row long before anyone could act on it. */
const CONFORMANCE_TTL_MS = 60_000;


/** Large enough to pull every active fact for the pinned-reserve warning
 *  check; not a real pagination limit — just avoids the store's normal
 *  ~100-row default silently truncating the pinned set it scans. */
const PINNED_SCAN_LIMIT = 100_000;

/**
 * Ceiling for the RETRIEVAL routes (`/recall`, `/impact`) and the brief's
 * `recentSessions` lane. 200 is picked, not inherited: the console's recall
 * view asks for 30, the MCP tools default to 10 (`ground_recall`) and 20
 * (`ground_impact`), and the widest window the product itself ever opens is
 * the brief's own 200-row fetch in both storage adapters. Nothing legitimate
 * asks for more, and above it /recall stops being retrieval and becomes a bulk
 * exporter: measured, `{"limit":1000}` returned 1000 rows / 624 KB in 0.53s on
 * an endpoint that is unauthenticated by default on localhost. Bulk reads
 * belong on the list routes, which page with `offset`.
 */
const MAX_RECALL_LIMIT = 200;

/**
 * Ceiling for the LIST routes (`/facts`, `/vision`, `/sessions`, `/docs`).
 * Deliberately looser than MAX_RECALL_LIMIT: these are the console's browse
 * surfaces, they return plain records rather than scored+snippeted cards, and
 * the shipped console asks for 2000 documents in a single page
 * (packages/ui/src/views/Docs.tsx) and 500 facts (views/Facts.tsx). 5000 keeps
 * every shipped caller working while still refusing an unbounded scan.
 */
const MAX_LIST_LIMIT = 5000;

/** Thrown by request guards; mapped to HTTP 400 in onError. */
class ValidationError extends GroundedError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

/** Thrown when a record lookup returns null; mapped to HTTP 404. */
class NotFoundError extends GroundedError {
  constructor(message: string) {
    super(message, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ValidationError(`"${field}" must be a non-empty string`);
  }
  return v;
}

function optString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`"${field}" must be a string`);
  return v;
}

function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(`"${field}" must be a boolean`);
  return v;
}

function optNumber(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new ValidationError(`"${field}" must be a number`);
  }
  return v;
}

/**
 * importance is a 0..1 weight: recall multiplies score by (1 + boost * importance)
 * and the brief orders by `importance desc`. An out-of-range value silently
 * outranks every other fact — including pinned ones — so reject it at the edge
 * rather than storing a ranking hijack.
 */
function optUnitNumber(v: unknown, field: string): number | undefined {
  const n = optNumber(v, field);
  if (n === undefined) return undefined;
  if (n < 0 || n > 1) {
    throw new ValidationError(`"${field}" must be between 0 and 1 (got ${n})`);
  }
  return n;
}

/**
 * `limit` is a ROW COUNT and every consumer of it assumes an integer: recall
 * cuts with `rankFlat(...).slice(0, limit)` and the stores hand it straight to
 * SQL `LIMIT`. A fractional value slips past `optNumber` and then over-serves —
 * measured, `{"query":"grounded","limit":2.1}` returned 200 with 3 rows and
 * `meta.limit: 2.1`, breaking the documented `returned <= limit` invariant
 * (`{"limit":5.5}` → 6 rows). Zero and negatives return an empty page while
 * echoing the nonsense straight back as `meta.limit`. And with no ceiling,
 * `{"limit":1000}` is a 624 KB response from a localhost-unauthenticated
 * endpoint.
 *
 * All four are a 400, never a silent clamp: a clamped limit is indistinguishable
 * from "the store ran out of rows" (`returned < limit`), which is the exact lie
 * `meta.available` exists to prevent — and pre-1.0 this API fails loudly
 * (see rejectUnknownKeys below).
 */
function optRowLimit(v: unknown, field: string, max: number): number | undefined {
  const n = optNumber(v, field);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`"${field}" must be a positive integer (got ${n})`);
  }
  if (n > max) {
    throw new ValidationError(`"${field}" must be at most ${max} (got ${n})`);
  }
  return n;
}

const FACT_STATUSES = ["active", "archived"] as const;

function optFactStatus(v: unknown, field: string): FactStatus | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !FACT_STATUSES.includes(v as (typeof FACT_STATUSES)[number])) {
    throw new ValidationError(`"${field}" must be one of ${FACT_STATUSES.join(", ")}`);
  }
  return v as FactStatus;
}

const FACT_ORIGINS = ["stated", "derived"] as const;

function optFactOrigin(v: unknown, field: string): FactOrigin | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !FACT_ORIGINS.includes(v as (typeof FACT_ORIGINS)[number])) {
    throw new ValidationError(`"${field}" must be one of ${FACT_ORIGINS.join(", ")}`);
  }
  return v as FactOrigin;
}

function optStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ValidationError(`"${field}" must be an array of strings`);
  }
  return v as string[];
}

function parseId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`invalid id "${raw}"`);
  return n;
}

/**
 * Offsets only. Zero is legal here (it is the first page) and is exactly why
 * this is NOT shared with the limit guard, where zero means "serve nothing" and
 * is a 400.
 */
function parseOffsetQuery(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`"${field}" must be a non-negative integer`);
  return n;
}

/** Query-string form of `optRowLimit` — same rules, same messages, so
 *  `?limit=2.1` and `{"limit":2.1}` fail identically. */
function parseLimitQuery(
  raw: string | undefined,
  field: string,
  max: number = MAX_LIST_LIMIT,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new ValidationError(`"${field}" must be a number`);
  return optRowLimit(n, field, max);
}

function parseTypedId(raw: string): TypedId {
  const idx = raw.indexOf(":");
  if (idx <= 0) throw new ValidationError(`invalid typed id "${raw}"`);
  const type = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  if (!SOURCE_TYPES.includes(type as SourceType)) {
    throw new ValidationError(`unknown source type "${type}"`);
  }
  const n = Number(idPart);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`invalid id in "${raw}"`);
  return `${type as SourceType}:${n}`;
}

/**
 * Reject body keys the route does not read. A silently-ignored key is the worst
 * failure mode this API has: the caller gets a 200 and believes an option took
 * effect. Measured case — a client sent `scopes`/`limit` to /brief for weeks;
 * both are dropped here (the brief lanes are `factScopes`/`docScopes`/
 * `recentSessions`), so its "locked lane" setting was a no-op and nothing said
 * so. Pre-1.0: fail loudly, and name the keys the route DOES accept.
 */
function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ValidationError(
      `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} — this route accepts: ${allowed.join(", ")}`,
    );
  }
}

/**
 * Apply one lane's write budget to one field and turn the verdict into the
 * API's own taxonomy: the ERROR tier is a `ValidationError` (400, same lane as
 * every other malformed body — never a silent truncation), the WARNING tier is
 * returned for the route to attach to its 2xx body.
 *
 * Both tiers come from `laneWriteVerdict`, which reads the resolved budget
 * table. No number is written down here.
 */
function enforceLane(
  budget: ResolvedLaneBudget,
  field: string,
  text: string | null | undefined,
  kind: "brief" | "body" = "brief",
): string | undefined {
  const verdict = laneWriteVerdict(budget, field, text, kind);
  if (verdict.error) throw new ValidationError(verdict.error);
  return verdict.warning;
}

const FACT_KEYS = ["fact","scope","category","detail","topicKey","pinned","importance","status","origin","createdBy","source"] as const;

function factInput(body: unknown, budget: ResolvedLaneBudget): FactInput {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, FACT_KEYS);
  const fact = asString(body.fact, "fact");
  const detail = optString(body.detail, "detail");
  // Measured on the rendered payload (`fact — detail`), the exact string the
  // facts reserve spends its budget on. Over the whole lane's cap it is a 400;
  // over one row's share it is a warning, attached to the 201 by
  // factWithDelivery. Live corpus: the longest of 38 facts renders at 396
  // chars against a 450-char row share, so nothing stored today would even
  // warn.
  enforceLane(budget, "fact", factBudgetText(fact, detail));
  return {
    fact,
    scope: optString(body.scope, "scope"),
    category: optString(body.category, "category"),
    detail,
    topicKey: optString(body.topicKey, "topicKey"),
    pinned: optBool(body.pinned, "pinned"),
    importance: optUnitNumber(body.importance, "importance"),
    status: optFactStatus(body.status, "status"),
    origin: optFactOrigin(body.origin, "origin"),
    createdBy: optString(body.createdBy, "createdBy"),
    source: optString(body.source, "source"),
  };
}

function factPatch(body: unknown, budget: ResolvedLaneBudget): Partial<FactInput> {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, FACT_KEYS);
  const patch: Partial<FactInput> = {};
  if (body.fact !== undefined) patch.fact = asString(body.fact, "fact");
  if (body.scope !== undefined) patch.scope = optString(body.scope, "scope");
  if (body.category !== undefined) patch.category = optString(body.category, "category");
  if (body.detail !== undefined) patch.detail = optString(body.detail, "detail");
  if (body.topicKey !== undefined) patch.topicKey = optString(body.topicKey, "topicKey");
  if (body.pinned !== undefined) patch.pinned = optBool(body.pinned, "pinned");
  if (body.importance !== undefined) patch.importance = optUnitNumber(body.importance, "importance");
  if (body.status !== undefined) patch.status = optFactStatus(body.status, "status");
  if (body.origin !== undefined) patch.origin = optFactOrigin(body.origin, "origin");
  if (body.createdBy !== undefined) patch.createdBy = optString(body.createdBy, "createdBy");
  if (body.source !== undefined) patch.source = optString(body.source, "source");
  // A PATCH sees only the fields it carries, so this measures what was SENT,
  // not the merged row — it can only ever under-count, never over-reject. The
  // merged truth is re-measured after the write (factWithDelivery), where the
  // stored record is in hand; a merge that lands over the lane cap surfaces
  // there as a warning rather than a 400 on a write that already happened.
  if (patch.fact !== undefined || patch.detail !== undefined) {
    enforceLane(budget, "fact", factBudgetText(patch.fact ?? "", patch.detail));
  }
  return patch;
}

// Clean break, no legacy `content` alias: Vision.content is gone from the
// contract (replaced by summary/details), matching the scope/source clean
// break already made in stage 3. Pre-1.0, one call site each in the
// SessionStart hook and the /fact skill are being updated in lockstep by the
// main thread — an alias would let a stale caller silently keep writing into
// the wrong field instead of failing loudly.
// The cap is DERIVED from `brief.reserve.vision`, never typed as its own
// number, so the write limit and the read budget cannot drift apart. Over-long
// vision was never rejected before, only silently truncated at read time by
// the brief -- which is how a 19k-char row survived unnoticed while every
// brief delivered its first 1600 chars and dropped the rest without a word.
// Failing the write is the only place the author is still present to fix it.
function visionInput(body: unknown, capChars: number): VisionInput {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, ["details", "summary", "scope", "createdBy", "source"]);
  const details = asString(body.details, "details");
  const capError = visionCapError(details, capChars);
  if (capError) throw new ValidationError(capError);
  // `summary` is the text the brief ACTUALLY injects when it is set (it
  // replaces `details` — see visionInjectedText), so it is budgeted by the
  // same reserve and capped by the same number. Unchecked before this, which
  // meant the one vision field that always reaches the brief was the one field
  // with no write cap.
  const summary = optString(body.summary, "summary");
  if (summary !== undefined) {
    const summaryCapError = visionCapError(summary, capChars);
    if (summaryCapError) {
      throw new ValidationError(summaryCapError.replace(/^details is/, '"summary" is'));
    }
  }
  return {
    details,
    summary,
    scope: optString(body.scope, "scope"),
    createdBy: optString(body.createdBy, "createdBy"),
    source: optString(body.source, "source"),
  };
}

const SESSION_KEYS = ["summary", "details", "project", "workspace", "agent", "machine", "tags", "source"] as const;

/** The warning half of a session write's budget verdict, attached to the 2xx
 *  body as `budget` when it fires. Sessions have no `delivery` rank to hang a
 *  warning off (that shape is facts-only), so this is their equivalent. */
export interface SessionBudgetSignal {
  lane: "sessions";
  warning: string;
  rowCapChars: number;
  laneCapChars: number;
  bodyCapChars: number | null;
}

function sessionBudgetSignal(
  budget: ResolvedLaneBudget,
  warnings: (string | undefined)[],
): SessionBudgetSignal | undefined {
  const fired = warnings.filter((w): w is string => Boolean(w));
  if (fired.length === 0) return undefined;
  return {
    lane: "sessions",
    warning: fired.join("; "),
    rowCapChars: budget.rowCapChars,
    laneCapChars: budget.laneCapChars,
    bodyCapChars: budget.bodyCapChars,
  };
}

/**
 * The sessions lane is two fields with two different contracts, and the budget
 * table says so rather than forcing one number on both:
 *
 *  - `summary` IS the brief's session line. Over its 250-char row share it
 *    warns (5 of 600 live sessions are — a hard 400 there would have rejected
 *    real, reasonable writes); over the whole 2000-char lane it is a 400,
 *    because one summary cannot be the entire recent-work section.
 *  - `details` is never injected into the brief at all (the lane renders
 *    summaries only), so it gets the lane's `bodyFactor` allowance — 16000
 *    chars, 8x the lane cap. The longest of 600 live session logs is 11,993.
 */
function sessionInput(
  body: unknown,
  budget: ResolvedLaneBudget,
): { input: SessionInput; budgetSignal?: SessionBudgetSignal } {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, SESSION_KEYS);
  const summary = asString(body.summary, "summary");
  const details = optString(body.details, "details");
  const budgetSignal = sessionBudgetSignal(budget, [
    enforceLane(budget, "summary", summary),
    enforceLane(budget, "details", details, "body"),
  ]);
  const input: SessionInput = {
    summary,
    details,
    project: optString(body.project, "project"),
    workspace: optString(body.workspace, "workspace"),
    agent: optString(body.agent, "agent"),
    machine: optString(body.machine, "machine"),
    tags: optStringArray(body.tags, "tags"),
    source: optString(body.source, "source"),
  };
  return budgetSignal ? { input, budgetSignal } : { input };
}

function sessionPatch(
  body: unknown,
  budget: ResolvedLaneBudget,
): { patch: Partial<SessionInput>; budgetSignal?: SessionBudgetSignal } {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, SESSION_KEYS);
  const patch: Partial<SessionInput> = {};
  if (body.summary !== undefined) patch.summary = asString(body.summary, "summary");
  if (body.details !== undefined) patch.details = optString(body.details, "details");
  if (body.project !== undefined) patch.project = optString(body.project, "project");
  if (body.workspace !== undefined) patch.workspace = optString(body.workspace, "workspace");
  if (body.agent !== undefined) patch.agent = optString(body.agent, "agent");
  if (body.machine !== undefined) patch.machine = optString(body.machine, "machine");
  if (body.tags !== undefined) patch.tags = optStringArray(body.tags, "tags");
  if (body.source !== undefined) patch.source = optString(body.source, "source");
  const budgetSignal = sessionBudgetSignal(budget, [
    patch.summary !== undefined ? enforceLane(budget, "summary", patch.summary) : undefined,
    patch.details !== undefined ? enforceLane(budget, "details", patch.details, "body") : undefined,
  ]);
  return budgetSignal ? { patch, budgetSignal } : { patch };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
}

/**
 * Body parser for routes where the body is optional (`/brief`, `/docs/prune`).
 * Reads the text and treats empty as `{}`. Deliberately does NOT sniff
 * `content-length`: that header is absent on chunked transfer-encoding requests,
 * which would silently discard a real body — dropping `docScopes` on /brief or
 * `remove` on /docs/prune with a 200 and no signal.
 */
async function readJsonOptional(c: {
  req: { text: () => Promise<string> };
}): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("invalid JSON body");
  }
}

export function createApp(
  store: Store,
  opts: {
    token?: string;
    /** The resolved budget table (`resolveBudget(config)`). When given it wins
     *  over the three legacy per-lane options below, which remain supported. */
    budget?: ResolvedBudget;
    typicalFactLimit?: number;
    factsReserveTok?: number;
    visionReserveTok?: number;
  } = {},
): Hono {
  const app = new Hono();
  const token = opts.token;
  // ONE table for this app: every write cap, every warning threshold, and the
  // table /health publishes all read from it. Threaded from the resolved
  // config by bin.ts -> startServer; falls back to the shipped LANE_BUDGETS so
  // an embedder calling createApp(store) directly enforces the same contract.
  const budget = resolveAppBudget(opts);
  const typicalFactLimit = budget.facts.rows;
  const factsReserveTok = budget.facts.reserveTok;
  const visionCap = visionCapChars(budget.vision.reserveTok);

  /** Assembles the write-time delivery signal for a fact write response.
   * Omits `delivery` entirely for an archived fact (factsDeliveryRank
   * returns null) rather than inventing a rank — an archived fact has no
   * delivery position. */
  async function factWithDelivery(fact: Fact): Promise<Fact | FactWriteResponse> {
    const rankInfo = await store.factsDeliveryRank(fact.id);
    if (!rankInfo) return fact;
    const { data: activeFacts } = await store.factsList({
      status: "active",
      limit: PINNED_SCAN_LIMIT,
    });
    const pinnedReserve = pinnedFactsReserveStatus(activeFacts, factsReserveTok);
    const delivery = computeDeliveryRank(
      rankInfo.rank,
      rankInfo.ofActive,
      typicalFactLimit,
      pinnedReserve,
      // terseness check on the text the writer actually controls. Both POST
      // and PATCH route through here, so an over-long fact is flagged on the
      // write that introduced it and the flag clears when it's shortened.
      fact.fact,
    );
    // The budget warning is measured on the STORED row, so a PATCH that merged
    // its way over the row share is reported even though the guard only saw
    // the patch. Joined into the existing `delivery.warning` rather than added
    // as a fourth shape — one write-time signal, several things it can say.
    const laneWarning = laneWriteVerdict(
      budget.facts,
      "fact",
      factBudgetText(fact.fact, fact.detail),
    ).warning;
    if (!laneWarning) return { ...fact, delivery };
    return {
      ...fact,
      delivery: {
        ...delivery,
        warning: delivery.warning ? `${delivery.warning}; ${laneWarning}` : laneWarning,
      },
    };
  }

  // Auth: when a token is configured, require it on every route except PUBLIC_PATHS.
  if (token) {
    app.use("*", async (c, next) => {
      if (PUBLIC_PATHS.has(c.req.path)) return next();
      const header = c.req.header("authorization") ?? "";
      const expected = `Bearer ${token}`;
      if (header !== expected) {
        return c.json({ error: "unauthorized", code: "UNAUTHORIZED" }, 401);
      }
      return next();
    });
  }

  /**
   * The conformance scan behind `/health.budget.*.conformance`: for each lane,
   * how many STORED rows currently violate the caps this process is enforcing.
   *
   * This is the whole point of publishing the table. A cap that lives only in
   * code is invisible when the running image predates it (exactly what
   * happened to the vision cap: the container kept accepting 9000-char writes
   * for weeks while the source rejected them at 1600). A caller can now read
   * the enforced caps AND the violation counts off one unauthenticated
   * endpoint and see the disagreement without probing it with a write.
   */
  async function scanConformance() {
    const measure = (
      lane: ResolvedLaneBudget,
      rows: { brief: string; body?: string | null }[],
      available: number,
    ) => ({
      checked: rows.length,
      overRowCap: rows.filter((r) => r.brief.length > lane.rowCapChars).length,
      overLaneCap: rows.filter((r) => r.brief.length > lane.laneCapChars).length,
      overBodyCap:
        lane.bodyCapChars === null
          ? 0
          : rows.filter((r) => (r.body?.length ?? 0) > lane.bodyCapChars!).length,
      complete: available <= rows.length,
    });

    const [visionRows, factRows, sessionRows] = await Promise.all([
      store.visionList({ limit: CONFORMANCE_SCAN_LIMIT }),
      store.factsList({ limit: CONFORMANCE_SCAN_LIMIT }),
      store.sessionsList({ limit: CONFORMANCE_SCAN_LIMIT }),
    ]);

    return {
      vision: measure(
        budget.vision,
        // Both stored fields are capped by the same number and either one can
        // be the injected text, so the longer of the two is what conformance
        // measures.
        visionRows.data.map((v) => ({
          brief: (v.summary ?? "").length > v.details.length ? v.summary! : v.details,
        })),
        visionRows.meta.available,
      ),
      facts: measure(
        budget.facts,
        factRows.data.map((f) => ({ brief: factBudgetText(f.fact, f.detail) })),
        factRows.meta.available,
      ),
      sessions: measure(
        budget.sessions,
        sessionRows.data.map((s) => ({ brief: s.summary, body: s.details })),
        sessionRows.meta.available,
      ),
    };
  }

  let conformanceCache: { at: number; value: Awaited<ReturnType<typeof scanConformance>> } | null =
    null;

  app.get("/health", async (c) => {
    const report = await store.health();
    const now = Date.now();
    if (!conformanceCache || now - conformanceCache.at > CONFORMANCE_TTL_MS) {
      conformanceCache = { at: now, value: await scanConformance() };
    }
    const conformance = conformanceCache.value;

    // counts.facts is the ONE number /health and /facts used to disagree on:
    // the adapters count raw rows (36) while GET /facts defaults to
    // status=active (34). Resolved on the ACTIVE basis — the same basis the
    // list route, the console's Facts card and the brief all use — with the
    // remainder published as `factsArchived` so nothing is hidden. Sessions
    // and docs have no status filter and already agreed.
    const active = await store.factsList({ status: "active", limit: 1 });
    const activeFacts = active.meta.available;
    const counts = {
      ...report.counts,
      facts: activeFacts,
      factsArchived: Math.max(0, report.counts.facts - activeFacts),
    };

    const laneOut = (lane: ResolvedLaneBudget, conf: (typeof conformance)["facts"]) => ({
      reserveTok: lane.reserveTok,
      rows: lane.rows,
      laneCapChars: lane.laneCapChars,
      rowCapChars: lane.rowCapChars,
      bodyCapChars: lane.bodyCapChars,
      briefField: lane.briefField,
      bodyField: lane.bodyField,
      conformance: conf,
    });

    return c.json({
      ...report,
      counts,
      budget: {
        vision: laneOut(budget.vision, conformance.vision),
        facts: laneOut(budget.facts, conformance.facts),
        sessions: laneOut(budget.sessions, conformance.sessions),
      },
    });
  });

  app.get("/openapi.json", (c) => c.json(openApiDocument));

  app.get("/llms.txt", (c) =>
    c.text(LLMS_TXT, 200, { "content-type": "text/markdown; charset=utf-8" }),
  );

  // ---- facts ----
  app.get("/facts", async (c) => {
    const scopesRaw = c.req.query("scopes");
    const statusRaw = c.req.query("status") ?? "active";
    if (statusRaw !== "active" && statusRaw !== "archived" && statusRaw !== "all") {
      throw new ValidationError('"status" must be one of active, archived, all');
    }
    const opts: ListOptions = {
      scope: c.req.query("scope"),
      scopes: scopesRaw
        ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      // "all" means "every status" — do not forward it to the store as a literal status value.
      status: statusRaw === "all" ? undefined : statusRaw,
      limit: parseLimitQuery(c.req.query("limit"), "limit"),
      offset: parseOffsetQuery(c.req.query("offset"), "offset"),
    };
    return c.json(await store.factsList(opts));
  });

  app.post("/facts", async (c) => {
    const input = factInput(await readJson(c), budget.facts);
    const fact = await store.factsAdd(input);
    return c.json(await factWithDelivery(fact), 201);
  });

  app.delete("/facts/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const deleted = await store.factsDelete(id);
    if (!deleted) throw new NotFoundError(`fact ${id} not found`);
    return c.json({ deleted: true, id });
  });

  app.patch("/facts/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const patch = factPatch(await readJson(c), budget.facts);
    const fact = await store.factsUpdate(id, patch);
    return c.json(await factWithDelivery(fact));
  });

  // ---- vision ----
  app.get("/vision", async (c) => {
    const opts: ListOptions = {
      scope: c.req.query("scope"),
      limit: parseLimitQuery(c.req.query("limit"), "limit"),
      offset: parseOffsetQuery(c.req.query("offset"), "offset"),
    };
    return c.json(await store.visionList(opts));
  });

  app.post("/vision", async (c) => {
    const input = visionInput(await readJson(c), visionCap);
    return c.json(await store.visionSet(input), 201);
  });

  app.delete("/vision/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const deleted = await store.visionDelete(id);
    if (!deleted) throw new NotFoundError(`vision ${id} not found`);
    return c.json({ deleted: true, id });
  });

  // ---- sessions ----
  app.get("/sessions", async (c) => {
    const opts: ListOptions = {
      project: c.req.query("project"),
      workspace: c.req.query("workspace"),
      limit: parseLimitQuery(c.req.query("limit"), "limit"),
      offset: parseOffsetQuery(c.req.query("offset"), "offset"),
    };
    return c.json(await store.sessionsList(opts));
  });

  app.post("/sessions", async (c) => {
    const { input, budgetSignal } = sessionInput(await readJson(c), budget.sessions);
    const session = await store.sessionsAdd(input);
    return c.json(budgetSignal ? { ...session, budget: budgetSignal } : session, 201);
  });

  app.get("/sessions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const session = await store.sessionsGet(id);
    if (!session) throw new NotFoundError(`session ${id} not found`);
    return c.json(session);
  });

  app.patch("/sessions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const { patch, budgetSignal } = sessionPatch(await readJson(c), budget.sessions);
    const session = await store.sessionsUpdate(id, patch);
    return c.json(budgetSignal ? { ...session, budget: budgetSignal } : session);
  });

  app.delete("/sessions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const deleted = await store.sessionsDelete(id);
    if (!deleted) throw new NotFoundError(`session ${id} not found`);
    return c.json({ deleted: true, id });
  });

  // ---- docs ----
  app.post("/docs/ingest", async (c) => {
    const body = await readJson(c);
    if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
    rejectUnknownKeys(body, ["paths", "source", "kind", "machine", "scope", "project", "dryRun"]);
    const paths = optStringArray(body.paths, "paths");
    if (!paths || paths.length === 0) {
      throw new ValidationError('"paths" must be a non-empty array of strings');
    }
    const ingestOpts: IngestOptions = {
      source: optString(body.source, "source"),
      kind: optString(body.kind, "kind"),
      machine: optString(body.machine, "machine"),
      scope: optString(body.scope, "scope"),
      project: optString(body.project, "project"),
      dryRun: optBool(body.dryRun, "dryRun"),
    };
    return c.json(await store.docsIngest(paths, ingestOpts));
  });

  app.post("/docs/prune", async (c) => {
    const body = await readJsonOptional(c);
    if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
    rejectUnknownKeys(body, ["remove"]);
    const remove = optBool(body.remove, "remove") ?? false;
    return c.json(await store.docsPrune({ remove }));
  });

  app.get("/docs", async (c) => {
    const scopesRaw = c.req.query("scopes");
    const opts: ListOptions = {
      limit: parseLimitQuery(c.req.query("limit"), "limit"),
      offset: parseOffsetQuery(c.req.query("offset"), "offset"),
      source: c.req.query("source"),
      scope: c.req.query("scope"),
      scopes: scopesRaw
        ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    };
    if (c.req.query("documents") === "true") opts.documents = true;
    return c.json(await store.docsList(opts));
  });

  app.get("/docs/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const doc = await store.docsGet(id);
    if (!doc) throw new NotFoundError(`doc ${id} not found`);
    return c.json(doc);
  });

  // ---- retrieval ----
  app.post("/recall", async (c) => {
    const body = await readJson(c);
    if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
    rejectUnknownKeys(body, [
      "query", "limit", "project", "workspace", "sources", "lexicalOnly", "scopes",
      "factScopes",
    ]);
    const query = asString(body.query, "query");
    const sources = optStringArray(body.sources, "sources");
    if (sources && sources.some((s) => !SOURCE_TYPES.includes(s as SourceType))) {
      throw new ValidationError(`"sources" must contain only ${SOURCE_TYPES.join(", ")}`);
    }
    const recallOpts: RecallOptions = {
      limit: optRowLimit(body.limit, "limit", MAX_RECALL_LIMIT),
      project: optString(body.project, "project"),
      sources: sources as SourceType[] | undefined,
      workspace: optString(body.workspace, "workspace"),
      lexicalOnly: optBool(body.lexicalOnly, "lexicalOnly"),
      scopes: optStringArray(body.scopes, "scopes"),
      // FACT-lane scope set — a different axis from `scopes`, which is the doc
      // lane. Omitted AND no `project` = no fact-scope filter at all.
      factScopes: optStringArray(body.factScopes, "factScopes"),
    };
    return c.json(await store.recall(query, recallOpts));
  });

  app.post("/impact", async (c) => {
    const body = await readJson(c);
    if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
    rejectUnknownKeys(body, ["subject", "limit", "project", "sources", "scopes"]);
    const subject = asString(body.subject, "subject");
    const sources = optStringArray(body.sources, "sources");
    if (sources && sources.some((s) => !SOURCE_TYPES.includes(s as SourceType))) {
      throw new ValidationError(`"sources" must contain only ${SOURCE_TYPES.join(", ")}`);
    }
    const impactOpts: ImpactOptions = {
      limit: optRowLimit(body.limit, "limit", MAX_RECALL_LIMIT),
      project: optString(body.project, "project"),
      sources: sources as SourceType[] | undefined,
      scopes: optStringArray(body.scopes, "scopes"),
    };
    return c.json(await store.impact(subject, impactOpts));
  });

  app.post("/brief", async (c) => {
    const body = await readJsonOptional(c);
    if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
    rejectUnknownKeys(body, [
      "agent", "project", "machine", "cwd", "query", "recentSessions",
      "factScopes", "docScopes", "timezone", "format",
    ]);
    const briefOpts: BriefOptions = {
      agent: optString(body.agent, "agent"),
      project: optString(body.project, "project"),
      machine: optString(body.machine, "machine"),
      cwd: optString(body.cwd, "cwd"),
      query: optString(body.query, "query"),
      // Same guard as a `limit`: `recentSessions` becomes `maxRows` in
      // truncateToReserve, whose `kept.length >= maxRows` test lets a
      // fractional 2.1 keep 3 rows — the identical over-serve /recall showed.
      // Bounded by MAX_RECALL_LIMIT because both adapters fetch
      // `Math.max(recentSessions, 200)`; a larger ask only widens the fetch.
      recentSessions: optRowLimit(body.recentSessions, "recentSessions", MAX_RECALL_LIMIT),
      factScopes: optStringArray(body.factScopes, "factScopes"),
      docScopes: optStringArray(body.docScopes, "docScopes"),
      timezone: ((): string | undefined => {
        const tz = optString(body.timezone, "timezone");
        if (tz === undefined) return undefined;
        // Reject here rather than letting the renderer fall back to UTC: a typo'd
        // zone that silently renders UTC is the exact failure this option exists
        // to fix, and it would look like the option simply doesn't work.
        if (!isValidTimeZone(tz)) {
          throw new ValidationError(`"timezone" must be a valid IANA zone (got "${tz}")`);
        }
        return tz;
      })(),
      format: ((): BriefOptions["format"] => {
        const f = optString(body.format, "format");
        if (f === undefined) return undefined;
        if (f !== "markdown" && f !== "json") {
          throw new ValidationError('"format" must be "markdown" or "json"');
        }
        return f;
      })(),
    };
    return c.json(await store.brief(briefOpts));
  });

  app.get("/get/:typedId", async (c) => {
    const typedId = parseTypedId(c.req.param("typedId"));
    const record = await store.get(typedId);
    if (!record) throw new NotFoundError(`${typedId} not found`);
    return c.json(record);
  });

  app.notFound((c) => c.json({ error: "not found", code: "NOT_FOUND" }, 404));

  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: err.code }, 404);
    }
    if (err instanceof EmbedError) {
      return c.json({ error: err.message, code: err.code }, 503);
    }
    // An unreadable ingest root is the caller's bad path, not a server fault —
    // 400 so it can never be mistaken for "the directory was empty".
    if (err instanceof IngestPathError) {
      return c.json({ error: err.message, code: err.code, paths: err.paths }, 400);
    }
    if (err instanceof StoreError || err instanceof ConfigError) {
      return c.json({ error: err.message, code: err.code }, 500);
    }
    if (err instanceof GroundedError) {
      return c.json({ error: err.message, code: err.code }, 500);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: message, code: "INTERNAL_ERROR" }, 500);
  });

  return app;
}
