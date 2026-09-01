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
import { computeDeliveryRank, pinnedFactsReserveStatus } from "@grounded/core/delivery";
import { openApiDocument } from "./openapi.js";
import { LLMS_TXT } from "./llms.js";

const SOURCE_TYPES: readonly SourceType[] = ["fact", "session", "doc"];

// Public without a token: liveness, and the agent-facing manual (an agent
// needs it to learn how to call Grounded before it has a token to call with).
const PUBLIC_PATHS = new Set(["/health", "/llms.txt"]);

/** Fallback for `createApp(store)` callers that pass no config. Kept in sync
 *  with defaultConfig().delivery.typicalFactLimit by the api test suite. */
const DEFAULT_TYPICAL_FACT_LIMIT = 8;

/** Fallback for `createApp(store)` callers that pass no config. Kept in sync
 *  with defaultConfig().brief.reserve.facts by the api test suite. */
const DEFAULT_FACTS_RESERVE_TOK = 900;

/** Large enough to pull every active fact for the pinned-reserve warning
 *  check; not a real pagination limit — just avoids the store's normal
 *  ~100-row default silently truncating the pinned set it scans. */
const PINNED_SCAN_LIMIT = 100_000;

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

function parseIntQuery(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`"${field}" must be a non-negative integer`);
  return n;
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

const FACT_KEYS = ["fact","scope","category","detail","topicKey","pinned","importance","status","origin","createdBy","source"] as const;

function factInput(body: unknown): FactInput {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, FACT_KEYS);
  return {
    fact: asString(body.fact, "fact"),
    scope: optString(body.scope, "scope"),
    category: optString(body.category, "category"),
    detail: optString(body.detail, "detail"),
    topicKey: optString(body.topicKey, "topicKey"),
    pinned: optBool(body.pinned, "pinned"),
    importance: optUnitNumber(body.importance, "importance"),
    status: optFactStatus(body.status, "status"),
    origin: optFactOrigin(body.origin, "origin"),
    createdBy: optString(body.createdBy, "createdBy"),
    source: optString(body.source, "source"),
  };
}

function factPatch(body: unknown): Partial<FactInput> {
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
  return patch;
}

// Clean break, no legacy `content` alias: Vision.content is gone from the
// contract (replaced by summary/details), matching the scope/source clean
// break already made in stage 3. Pre-1.0, one call site each in the
// SessionStart hook and the /fact skill are being updated in lockstep by the
// main thread — an alias would let a stale caller silently keep writing into
// the wrong field instead of failing loudly.
function visionInput(body: unknown): VisionInput {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, ["details", "summary", "scope", "createdBy", "source"]);
  return {
    details: asString(body.details, "details"),
    summary: optString(body.summary, "summary"),
    scope: optString(body.scope, "scope"),
    createdBy: optString(body.createdBy, "createdBy"),
    source: optString(body.source, "source"),
  };
}

const SESSION_KEYS = ["summary", "details", "project", "workspace", "agent", "machine", "tags", "source"] as const;

function sessionInput(body: unknown): SessionInput {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  rejectUnknownKeys(body, SESSION_KEYS);
  return {
    summary: asString(body.summary, "summary"),
    details: optString(body.details, "details"),
    project: optString(body.project, "project"),
    workspace: optString(body.workspace, "workspace"),
    agent: optString(body.agent, "agent"),
    machine: optString(body.machine, "machine"),
    tags: optStringArray(body.tags, "tags"),
    source: optString(body.source, "source"),
  };
}

function sessionPatch(body: unknown): Partial<SessionInput> {
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
  return patch;
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
  opts: { token?: string; typicalFactLimit?: number; factsReserveTok?: number } = {},
): Hono {
  const app = new Hono();
  const token = opts.token;
  // Threaded from the resolved config by bin.ts -> startServer. The fallback
  // matches defaultConfig().delivery.typicalFactLimit so an embedder calling
  // createApp(store) directly still gets the signal rather than silently
  // losing it.
  const typicalFactLimit = opts.typicalFactLimit ?? DEFAULT_TYPICAL_FACT_LIMIT;
  // Same threading pattern, for the pinned-reserve warning: matches
  // defaultConfig().brief.reserve.facts.
  const factsReserveTok = opts.factsReserveTok ?? DEFAULT_FACTS_RESERVE_TOK;

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
    return { ...fact, delivery };
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

  app.get("/health", async (c) => c.json(await store.health()));

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
      limit: parseIntQuery(c.req.query("limit"), "limit"),
      offset: parseIntQuery(c.req.query("offset"), "offset"),
    };
    return c.json(await store.factsList(opts));
  });

  app.post("/facts", async (c) => {
    const input = factInput(await readJson(c));
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
    const patch = factPatch(await readJson(c));
    const fact = await store.factsUpdate(id, patch);
    return c.json(await factWithDelivery(fact));
  });

  // ---- vision ----
  app.get("/vision", async (c) => {
    const opts: ListOptions = {
      scope: c.req.query("scope"),
      limit: parseIntQuery(c.req.query("limit"), "limit"),
      offset: parseIntQuery(c.req.query("offset"), "offset"),
    };
    return c.json(await store.visionList(opts));
  });

  app.post("/vision", async (c) => {
    const input = visionInput(await readJson(c));
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
      limit: parseIntQuery(c.req.query("limit"), "limit"),
      offset: parseIntQuery(c.req.query("offset"), "offset"),
    };
    return c.json(await store.sessionsList(opts));
  });

  app.post("/sessions", async (c) => {
    const input = sessionInput(await readJson(c));
    return c.json(await store.sessionsAdd(input), 201);
  });

  app.get("/sessions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const session = await store.sessionsGet(id);
    if (!session) throw new NotFoundError(`session ${id} not found`);
    return c.json(session);
  });

  app.patch("/sessions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const patch = sessionPatch(await readJson(c));
    return c.json(await store.sessionsUpdate(id, patch));
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
      limit: parseIntQuery(c.req.query("limit"), "limit"),
      offset: parseIntQuery(c.req.query("offset"), "offset"),
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
    ]);
    const query = asString(body.query, "query");
    const sources = optStringArray(body.sources, "sources");
    if (sources && sources.some((s) => !SOURCE_TYPES.includes(s as SourceType))) {
      throw new ValidationError(`"sources" must contain only ${SOURCE_TYPES.join(", ")}`);
    }
    const recallOpts: RecallOptions = {
      limit: optNumber(body.limit, "limit"),
      project: optString(body.project, "project"),
      sources: sources as SourceType[] | undefined,
      workspace: optString(body.workspace, "workspace"),
      lexicalOnly: optBool(body.lexicalOnly, "lexicalOnly"),
      scopes: optStringArray(body.scopes, "scopes"),
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
      limit: optNumber(body.limit, "limit"),
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
      recentSessions: optNumber(body.recentSessions, "recentSessions"),
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
