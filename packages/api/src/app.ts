import { Hono } from "hono";
import {
  ConfigError,
  EmbedError,
  GroundedError,
  StoreError,
} from "@grounded/core/contract";
import type {
  BriefOptions,
  FactInput,
  IngestOptions,
  ListOptions,
  RecallOptions,
  SessionInput,
  SourceType,
  Store,
  TypedId,
} from "@grounded/core/contract";
import { openApiDocument } from "./openapi.js";

const SOURCE_TYPES: readonly SourceType[] = ["fact", "session", "doc"];

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

function factInput(body: unknown): FactInput {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
  return {
    fact: asString(body.fact, "fact"),
    scope: optString(body.scope, "scope"),
    category: optString(body.category, "category"),
    detail: optString(body.detail, "detail"),
    topicKey: optString(body.topicKey, "topicKey"),
    pinned: optBool(body.pinned, "pinned"),
    importance: optNumber(body.importance, "importance"),
    createdBy: optString(body.createdBy, "createdBy"),
    source: optString(body.source, "source"),
  };
}

function sessionInput(body: unknown): SessionInput {
  if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
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

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
}

export function createApp(store: Store, opts: { token?: string } = {}): Hono {
  const app = new Hono();
  const token = opts.token;

  // Auth: when a token is configured, require it on every route except /health.
  if (token) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/health") return next();
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

  // ---- facts ----
  app.get("/facts", async (c) => {
    const scopesRaw = c.req.query("scopes");
    const opts: ListOptions = {
      scope: c.req.query("scope"),
      scopes: scopesRaw
        ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      status: c.req.query("status"),
      limit: parseIntQuery(c.req.query("limit"), "limit"),
      offset: parseIntQuery(c.req.query("offset"), "offset"),
    };
    return c.json(await store.factsList(opts));
  });

  app.post("/facts", async (c) => {
    const input = factInput(await readJson(c));
    return c.json(await store.factsAdd(input), 201);
  });

  app.delete("/facts/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const deleted = await store.factsDelete(id);
    if (!deleted) throw new NotFoundError(`fact ${id} not found`);
    return c.json({ deleted: true, id });
  });

  app.post("/facts/:id/supersede", async (c) => {
    const id = parseId(c.req.param("id"));
    const input = factInput(await readJson(c));
    return c.json(await store.factsSupersede(id, input), 201);
  });

  // ---- sessions ----
  app.get("/sessions", async (c) => {
    const opts: ListOptions = {
      project: c.req.query("project"),
      limit: parseIntQuery(c.req.query("limit"), "limit"),
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

  // ---- docs ----
  app.post("/docs/ingest", async (c) => {
    const body = await readJson(c);
    if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
    const paths = optStringArray(body.paths, "paths");
    if (!paths || paths.length === 0) {
      throw new ValidationError('"paths" must be a non-empty array of strings');
    }
    const ingestOpts: IngestOptions = {
      source: optString(body.source, "source"),
      kind: optString(body.kind, "kind"),
      dryRun: optBool(body.dryRun, "dryRun"),
    };
    return c.json(await store.docsIngest(paths, ingestOpts));
  });

  app.get("/docs", async (c) => {
    const opts: ListOptions = {
      limit: parseIntQuery(c.req.query("limit"), "limit"),
      offset: parseIntQuery(c.req.query("offset"), "offset"),
    };
    const source = c.req.query("source");
    if (source !== undefined) opts.scope = source;
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
    const query = asString(body.query, "query");
    const sources = optStringArray(body.sources, "sources");
    if (sources && sources.some((s) => !SOURCE_TYPES.includes(s as SourceType))) {
      throw new ValidationError(`"sources" must contain only ${SOURCE_TYPES.join(", ")}`);
    }
    const recallOpts: RecallOptions = {
      limit: optNumber(body.limit, "limit"),
      project: optString(body.project, "project"),
      sources: sources as SourceType[] | undefined,
      lexicalOnly: optBool(body.lexicalOnly, "lexicalOnly"),
    };
    return c.json(await store.recall(query, recallOpts));
  });

  app.post("/brief", async (c) => {
    const raw = c.req.header("content-length");
    const body = raw && raw !== "0" ? await readJson(c) : {};
    if (!isRecord(body)) throw new ValidationError("body must be a JSON object");
    const briefOpts: BriefOptions = {
      agent: optString(body.agent, "agent"),
      project: optString(body.project, "project"),
      machine: optString(body.machine, "machine"),
      cwd: optString(body.cwd, "cwd"),
      query: optString(body.query, "query"),
      recentSessions: optNumber(body.recentSessions, "recentSessions"),
      factScopes: optStringArray(body.factScopes, "factScopes"),
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
