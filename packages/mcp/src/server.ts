import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GroundedError, defaultConfig } from "@grounded/core";
import {
  computeDeliveryRank,
  pinnedFactsReserveStatus,
  visionCapChars,
  visionCapError,
} from "@grounded/core/delivery";
import type {
  Store,
  RecallResult,
  ImpactResult,
  SourceType,
  TypedId,
  BriefOptions,
} from "@grounded/core";

type ToolText = CallToolResult;

function text(value: string): ToolText {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): ToolText {
  return text(JSON.stringify(value, null, 2));
}

function toolError(err: unknown): ToolText {
  let message: string;
  if (err instanceof GroundedError) {
    message = `${err.code}: ${err.message}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a handler so core errors map to MCP tool errors instead of throwing through the transport. */
function guard<A>(fn: (args: A) => Promise<ToolText>): (args: A) => Promise<ToolText> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return toolError(err);
    }
  };
}

/** Compact one-line render of a recall card (no body — progressive disclosure). */
function renderCard(r: RecallResult): string {
  const meta = [r.matchedBy, `score=${r.score.toFixed(4)}`].join(" · ");
  const where = r.path ?? r.source ?? "";
  const tail = where ? `  (${where})` : "";
  return `[${r.typedId}] ${r.title}${tail}\n  ${meta} · ${r.citation}\n  ${r.snippet}`;
}

/**
 * Compact one-line render of an impact card. Out-of-lane hits are withheld —
 * they must read as "a dependency exists, here's where" rather than a blank
 * or nulled-out card, so this does NOT delegate to renderCard.
 */
function renderImpactCard(r: ImpactResult): string {
  const meta = [r.matchedBy, `score=${r.score.toFixed(4)}`].join(" · ");
  const where = r.path ?? r.source ?? "";
  const tail = where ? `  (${where})` : "";
  if (!r.inScope) {
    return `[${r.typedId}] (content withheld — lane: ${r.scope})${tail}\n  ${meta} · ${r.citation}`;
  }
  return `[${r.typedId}] ${r.title}${tail}\n  ${meta} · ${r.citation}\n  ${r.snippet}`;
}

/**
 * Wrap a tool's input shape in a STRICT object.
 *
 * Grounded's standing rule: unknown body keys are a 400 on every JSON route —
 * a silently-ignored option is a 200 that lies. MCP is the *primary* agent
 * contract, so it is the surface where that lie costs most: an agent that sends
 * `limmit` instead of `limit` gets a different result set and has no way to
 * know. zod objects are non-strict by default, which stripped exactly those
 * keys, so every tool here must opt in explicitly.
 *
 * The errorMap reproduces the HTTP layer's wording (`rejectUnknownKeys` in
 * packages/api/src/app.ts) so the two agent-facing surfaces phrase the same
 * refusal the same way. `additionalProperties: false` now also rides along in
 * the published JSON Schema, so a well-behaved client can see the rule before
 * it breaks it.
 */
function strictInput<T extends z.ZodRawShape>(shape: T) {
  const allowed = Object.keys(shape);
  return z
    .object(shape, {
      errorMap: (issue, ctx) => {
        if (issue.code === z.ZodIssueCode.unrecognized_keys) {
          const keys = issue.keys.map((k) => `"${k}"`).join(", ");
          return {
            message:
              `unknown field${issue.keys.length > 1 ? "s" : ""} ${keys} — ` +
              `this tool accepts: ${allowed.join(", ")}`,
          };
        }
        return { message: ctx.defaultError };
      },
    })
    .strict();
}

const SOURCE_TYPES = ["fact", "session", "doc"] as const;

/** Same ceilings the HTTP routes enforce (packages/api/src/app.ts) — the two
 *  agent-facing surfaces must not disagree on what a legal row count is.
 *  Retrieval tools cap at 200; the facts LISTING tool gets the looser browse
 *  ceiling. `.int().positive()` already rejects fractional/zero/negative here;
 *  only the upper bound was missing. */
const MAX_RECALL_LIMIT = 200;
const MAX_LIST_LIMIT = 5000;

const TYPED_ID_RE = /^(fact|session|doc):\d+$/;

/**
 * `typicalFactLimit` is the threshold `computeDeliveryRank` uses to decide
 * whether a freshly-written fact warrants a "you will not be seen" warning.
 * It comes from `cfg.delivery.typicalFactLimit`, threaded in by bin.ts —
 * defaulting here only so an embedder calling `createServer(store)` still gets
 * correct out-of-the-box behaviour.
 */
export function createServer(
  store: Store,
  opts: { typicalFactLimit?: number; factsReserveTok?: number; visionReserveTok?: number } = {},
): McpServer {
  const typicalFactLimit = opts.typicalFactLimit ?? defaultConfig().delivery.typicalFactLimit;
  // Same threading pattern as typicalFactLimit, for the pinned-reserve
  // write-time warning: matches cfg.brief.reserve.facts.
  const factsReserveTok = opts.factsReserveTok ?? defaultConfig().brief.reserve.facts;
  // Same threading pattern again, for the vision write cap. MCP writes vision
  // straight to the store without passing through the API's request validator,
  // so without this an MCP agent could store a row the brief would silently
  // truncate -- the exact failure the cap exists to end.
  const visionCap = visionCapChars(opts.visionReserveTok ?? defaultConfig().brief.reserve.vision);

  /** Active facts scanned to compute the pinned set's share of the facts
   *  reserve. Large limit — this must see every active fact, not the
   *  store's normal ~100-row list default. */
  async function pinnedReserve(): Promise<{ renderedChars: number; reserveChars: number }> {
    const { data: activeFacts } = await store.factsList({ status: "active", limit: 100_000 });
    return pinnedFactsReserveStatus(activeFacts, factsReserveTok);
  }
  const server = new McpServer(
    { name: "grounded", version: "0.1.0" },
    {
      instructions:
        "Grounded continuity store. Use ground_recall for compact cited cards, then " +
        "ground_get / ground_timeline to fetch detail by typedId. ground_brief gives startup context.",
    },
  );

  server.registerTool(
    "ground_recall",
    {
      title: "Recall",
      description:
        "Hybrid search across facts, sessions, and docs. Returns compact cited cards " +
        "(no full bodies). Pick a typedId and call ground_get or ground_timeline for detail.",
      inputSchema: strictInput({
        query: z.string().describe("natural-language query"),
        limit: z.number().int().positive().max(MAX_RECALL_LIMIT).optional().describe("total results across sources (default 10, max 200)"),
        project: z
          .string()
          .optional()
          .describe(
            'HARD filter on the session lane AND the fact lane (fact scopes become ["global","project:<name>"]); docs are narrowed by `scopes` instead',
          ),
        sources: z.array(z.enum(SOURCE_TYPES)).optional().describe("restrict to these source types"),
        lexicalOnly: z.boolean().optional().describe("force lexical-only (skip embeddings)"),
        scopes: z
          .array(z.string())
          .optional()
          .describe(
            'filters the doc lane; defaults to ["global"] — pass e.g. ["global","administration"] to also include another lane, not just the other lane alone',
          ),
        factScopes: z
          .array(z.string())
          .optional()
          .describe(
            'filters the FACT lane — a different axis from `scopes`; overrides the set `project` implies. Omitted with no `project` = no fact-scope filter at all',
          ),
      }),
    },
    guard(async ({ query, limit, project, sources, lexicalOnly, scopes, factScopes }) => {
      const { data, meta } = await store.recall(query, {
        ...(limit !== undefined ? { limit } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(sources !== undefined ? { sources: sources as SourceType[] } : {}),
        ...(lexicalOnly !== undefined ? { lexicalOnly } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(factScopes !== undefined ? { factScopes } : {}),
      });
      if (data.length === 0) {
        return { content: [{ type: "text", text: "No results.\n\n[]" }] };
      }
      const bySourceParts = SOURCE_TYPES.filter((s) => (meta.bySource?.[s]?.available ?? 0) > 0).map(
        (s) => `${s} ${meta.bySource![s]!.returned}/${meta.bySource![s]!.available}`,
      );
      const metaLine =
        `${meta.returned} of ${meta.available} matched` +
        (bySourceParts.length ? ` (${bySourceParts.join(" · ")}${meta.truncated ? ", truncated" : ""})` : "");
      const cards = data.map(renderCard).join("\n\n");
      const body = `${metaLine}\n\n${cards}\n\n--- raw JSON (pick typedId) ---\n${JSON.stringify(data)}`;
      return text(body);
    }),
  );

  server.registerTool(
    "ground_impact",
    {
      title: "Impact",
      description:
        "Reverse lookup — 'what depends on X?'. Call this BEFORE stopping, removing, deleting, or " +
        "renaming infrastructure (a container, a port, a path, a service) as a dependency pre-flight, " +
        "not a search. Lexical-only by construction: subject is a literal token, not a natural-language " +
        "query. Deliberately crosses lane boundaries — out-of-lane doc hits are still returned, but " +
        "content-withheld: you learn THAT a dependency exists and where, not what it says.",
      inputSchema: strictInput({
        subject: z.string().describe("literal token to search for — a container name, a port, a path"),
        limit: z.number().int().positive().max(MAX_RECALL_LIMIT).optional().describe("total results across sources (default 20, max 200)"),
        project: z.string().optional().describe("scope filter for facts/sessions"),
        sources: z.array(z.enum(SOURCE_TYPES)).optional().describe("restrict to these source types"),
        scopes: z
          .array(z.string())
          .optional()
          .describe(
            'doc lanes whose CONTENT you may see; defaults to ["global"]. Does NOT filter the result ' +
              "set — out-of-lane hits are still returned, content withheld.",
          ),
      }),
    },
    guard(async ({ subject, limit, project, sources, scopes }) => {
      const { data, meta } = await store.impact(subject, {
        ...(limit !== undefined ? { limit } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(sources !== undefined ? { sources: sources as SourceType[] } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
      });
      if (data.length === 0) {
        return { content: [{ type: "text", text: "No dependents found.\n\n[]" }] };
      }
      const bySourceParts = SOURCE_TYPES.filter((s) => (meta.bySource?.[s]?.available ?? 0) > 0).map(
        (s) => `${s} ${meta.bySource![s]!.returned}/${meta.bySource![s]!.available}`,
      );
      const metaLine =
        `${meta.returned} of ${meta.available} matched` +
        (bySourceParts.length ? ` (${bySourceParts.join(" · ")}${meta.truncated ? ", truncated" : ""})` : "");
      const cards = data.map(renderImpactCard).join("\n\n");
      const body = `${metaLine}\n\n${cards}\n\n--- raw JSON (pick typedId) ---\n${JSON.stringify(data)}`;
      return text(body);
    }),
  );

  server.registerTool(
    "ground_timeline",
    {
      title: "Timeline",
      description: "Sessions around an anchor (session id or query). Use after ground_recall to expand context.",
      inputSchema: strictInput({
        around: z.number().int().optional().describe("anchor session id"),
        query: z.string().optional().describe("anchor by query instead of id"),
        project: z.string().optional(),
        window: z.number().int().positive().optional().describe("entries before/after the anchor"),
      }),
    },
    guard(async ({ around, query, project, window }) => {
      const sessions = await store.sessionsTimeline({
        ...(around !== undefined ? { around } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(window !== undefined ? { window } : {}),
      });
      return json(sessions);
    }),
  );

  server.registerTool(
    "ground_get",
    {
      title: "Get",
      description: "Fetch the full record for a typedId (e.g. fact:2, session:274, doc:1091).",
      inputSchema: strictInput({
        typedId: z
          .string()
          .regex(TYPED_ID_RE, "expected <fact|session|doc>:<id>")
          .describe("typed id from a recall card"),
      }),
    },
    guard(async ({ typedId }) => {
      const record = await store.get(typedId as TypedId);
      if (record === null) return text(`Not found: ${typedId}`);
      return json(record);
    }),
  );

  server.registerTool(
    "ground_brief",
    {
      title: "Brief",
      description: "Assemble scoped startup context (recent sessions + facts + related docs). Markdown by default.",
      inputSchema: strictInput({
        agent: z.string().optional(),
        project: z.string().optional(),
        machine: z.string().optional(),
        cwd: z.string().optional(),
        query: z.string().optional().describe("bias related-docs selection"),
        format: z.enum(["markdown", "json"]).optional().describe("default markdown"),
        docScopes: z
          .array(z.string())
          .optional()
          .describe(
            'filters the related-docs lane; defaults to ["global"] — pass e.g. ["global","administration"] to also include another lane, not just the other lane alone',
          ),
        timezone: z
          .string()
          .optional()
          .describe(
            'IANA zone (e.g. "America/Chicago") for the rendered session dates; defaults to UTC. Display only — stored instants and the JSON createdAt are always UTC. Pass your local zone: the markdown line is a DATE ONLY, so west of UTC anything logged in the local evening otherwise renders as tomorrow',
          ),
      }),
    },
    guard(async ({ agent, project, machine, cwd, query, format, docScopes, timezone }) => {
      const opts: BriefOptions = {
        format: format ?? "markdown",
        ...(agent !== undefined ? { agent } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(machine !== undefined ? { machine } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(docScopes !== undefined ? { docScopes } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
      };
      const brief = await store.brief(opts);
      if (opts.format === "json") return json(brief);
      return text(brief.text ?? brief.startupNote);
    }),
  );

  server.registerTool(
    "ground_vision_get",
    {
      title: "Get vision",
      description:
        "Get the active Global Vision and, when project is given, that Project Vision — the direction the work serves.",
      inputSchema: strictInput({
        project: z.string().optional().describe("project name (loads its Project Vision too)"),
      }),
    },
    guard(async ({ project }) => {
      const global = await store.visionGet("global");
      const proj = project ? await store.visionGet(`project:${project}`) : null;
      return json({ global, project: proj });
    }),
  );

  server.registerTool(
    "ground_vision_set",
    {
      title: "Set vision",
      description:
        "Set the vision for a scope (narrative markdown). Edits the one active record for that scope in place. " +
        "`details` is the full narrative markdown — never recalled and never injected; read it back with " +
        "ground_vision_get. `summary` is the short form injected at SessionStart; omit it to fall back to a " +
        "truncated `details` for injection. `details` is CAPPED — objectives and committed next steps only, " +
        "history belongs in sessions. Over the cap the write is rejected, not truncated.",
      inputSchema: strictInput({
        details: z
          .string()
          .describe(
            `the vision itself — narrative markdown, at most ${visionCap} chars. Never recalled, never injected.`,
          ),
        summary: z
          .string()
          .optional()
          .describe("short form injected at SessionStart; never recalled. Falls back to truncated details when omitted."),
        scope: z.string().optional().describe('"global" (default) or "project:<name>"'),
      }),
    },
    guard(async ({ details, summary, scope }) => {
      const capError = visionCapError(details, visionCap);
      if (capError) throw new Error(capError);
      const created = await store.visionSet({
        details,
        ...(summary !== undefined ? { summary } : {}),
        ...(scope !== undefined ? { scope } : {}),
        source: "mcp",
      });
      return json(created);
    }),
  );

  server.registerTool(
    "ground_facts_add",
    {
      title: "Add fact",
      description:
        "Add a durable fact (explicit operator truth). If topicKey matches an already-ACTIVE fact " +
        "in the same scope, this UPSERTS that fact in place (merge-patch — any field you omit keeps " +
        "its stored value) instead of creating a second, competing row. Restating a pinned fact through " +
        "this tool without repeating pinned:true will NOT unpin it. An archived fact holding the same " +
        "key does not block a fresh active row from claiming it.",
      inputSchema: strictInput({
        fact: z.string().describe("the sharp one-liner rule"),
        scope: z.string().optional().describe('e.g. "global", "project:x", "agent:y"'),
        category: z.string().optional(),
        detail: z.string().optional().describe("elaboration / when-to-apply"),
        topicKey: z
          .string()
          .optional()
          .describe(
            "stable dedupe key — supplying the same (scope, topicKey) as an active fact upserts it in place rather than duplicating",
          ),
        pinned: z.boolean().optional(),
        importance: z.number().min(0).max(1).optional().describe("0..1 ranking boost"),
        status: z.enum(["active", "archived"]).optional().describe('defaults to "active"'),
        origin: z
          .enum(["stated", "derived"])
          .optional()
          .describe(
            'defaults to "stated". "stated" = an operator or agent is asserting this outright — use this for ' +
              'virtually every call. "derived" is reserved for synthesis inferring a fact from other data; it must ' +
              "never be used to make a guess look like operator truth.",
          ),
      }),
    },
    guard(async ({ fact, scope, category, detail, topicKey, pinned, importance, status, origin }) => {
      const created = await store.factsAdd({
        fact,
        ...(scope !== undefined ? { scope } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(topicKey !== undefined ? { topicKey } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(importance !== undefined ? { importance } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(origin !== undefined ? { origin } : {}),
      });
      const rank = await store.factsDeliveryRank(created.id);
      const delivery = rank
        ? computeDeliveryRank(rank.rank, rank.ofActive, typicalFactLimit, await pinnedReserve())
        : null;
      return json(delivery ? { ...created, delivery } : created);
    }),
  );

  server.registerTool(
    "ground_facts_update",
    {
      title: "Update fact",
      description: "Edit a fact in place by id. Only provided fields change; re-embeds when text changes.",
      inputSchema: strictInput({
        id: z.number().int().describe("fact id"),
        fact: z.string().optional().describe("the sharp one-liner rule"),
        scope: z.string().optional(),
        category: z.string().optional(),
        detail: z.string().optional(),
        topicKey: z.string().optional(),
        pinned: z.boolean().optional(),
        importance: z.number().min(0).max(1).optional(),
        status: z.enum(["active", "archived"]).optional().describe("archive/restore a fact"),
        origin: z
          .enum(["stated", "derived"])
          .optional()
          .describe(
            '"stated" = an operator or agent asserted this outright. "derived" is reserved for synthesis and ' +
              "must never be used to present an inference as operator truth. Omit to leave the fact's existing origin untouched.",
          ),
      }),
    },
    guard(async ({ id, fact, scope, category, detail, topicKey, pinned, importance, status, origin }) => {
      const updated = await store.factsUpdate(id, {
        ...(fact !== undefined ? { fact } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(topicKey !== undefined ? { topicKey } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(importance !== undefined ? { importance } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(origin !== undefined ? { origin } : {}),
      });
      const rank = await store.factsDeliveryRank(updated.id);
      const delivery = rank
        ? computeDeliveryRank(rank.rank, rank.ofActive, typicalFactLimit, await pinnedReserve())
        : null;
      return json(delivery ? { ...updated, delivery } : updated);
    }),
  );

  server.registerTool(
    "ground_facts_list",
    {
      title: "List facts",
      description: "List facts, pinned/importance first. Defaults to active facts only.",
      inputSchema: strictInput({
        scope: z.string().optional(),
        limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
        status: z
          .enum(["active", "archived", "all"])
          .optional()
          .describe('defaults to "active"; "all" returns every status'),
      }),
    },
    guard(async ({ scope, limit, status }) => {
      const facts = await store.factsList({
        ...(scope !== undefined ? { scope } : {}),
        ...(limit !== undefined ? { limit } : {}),
        status: status === undefined || status === "active" ? "active" : status === "all" ? undefined : status,
      });
      return json(facts);
    }),
  );

  server.registerTool(
    "ground_facts_delete",
    {
      title: "Delete fact",
      description: "Delete a fact by id.",
      inputSchema: strictInput({ id: z.number().int().describe("fact id") }),
    },
    guard(async ({ id }) => {
      const ok = await store.factsDelete(id);
      return json({ deleted: ok, id });
    }),
  );

  server.registerTool(
    "ground_session_add",
    {
      title: "Add session",
      description: "Append a session (work-log entry).",
      inputSchema: strictInput({
        summary: z.string().describe("one-line summary"),
        details: z.string().optional(),
        project: z.string().optional(),
        agent: z.string().optional(),
        machine: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    },
    guard(async ({ summary, details, project, agent, machine, tags }) => {
      const created = await store.sessionsAdd({
        summary,
        ...(details !== undefined ? { details } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(machine !== undefined ? { machine } : {}),
        ...(tags !== undefined ? { tags } : {}),
      });
      return json(created);
    }),
  );

  server.registerTool(
    "ground_session_update",
    {
      title: "Update session",
      description:
        "Edit a session in place (partial patch; omitted fields keep their value). Use this to correct a work-log entry instead of writing a second one.",
      inputSchema: strictInput({
        id: z.number().int().describe("session id"),
        summary: z.string().optional(),
        details: z.string().optional(),
        project: z.string().optional(),
        workspace: z.string().optional(),
        agent: z.string().optional(),
        machine: z.string().optional(),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
      }),
    },
    guard(async ({ id, ...patch }) => {
      const updated = await store.sessionsUpdate(id, patch);
      return json(updated);
    }),
  );

  server.registerTool(
    "ground_session_delete",
    {
      title: "Delete session",
      description: "Delete a session (work-log entry) by id. Not reversible.",
      inputSchema: strictInput({ id: z.number().int().describe("session id") }),
    },
    guard(async ({ id }) => {
      const ok = await store.sessionsDelete(id);
      return json({ deleted: ok, id });
    }),
  );

  server.registerTool(
    "ground_docs_ingest",
    {
      title: "Ingest docs",
      description: "Ingest/index files or directories. Idempotent (bodyHash dedupe). Returns an IngestReport.",
      inputSchema: strictInput({
        paths: z.array(z.string()).min(1).describe("file or directory paths"),
        source: z.string().optional().describe("logical source label"),
        kind: z.string().optional(),
        machine: z.string().optional().describe("machine label to tag ingested rows with"),
        scope: z.string().optional().describe('lane to tag ingested rows with (default "global")'),
        dryRun: z.boolean().optional().describe("report changes without writing"),
      }),
    },
    guard(async ({ paths, source, kind, machine, scope, dryRun }) => {
      const report = await store.docsIngest(paths, {
        ...(source !== undefined ? { source } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(machine !== undefined ? { machine } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
      });
      return json(report);
    }),
  );

  server.registerTool(
    "ground_docs_prune",
    {
      title: "Prune docs",
      description:
        "Reconcile doc rows against files on disk: mark rows missing, or delete them with remove:true. " +
        "Distinct from IngestReport.removed (stale chunk indexes inside re-chunked files, not orphan detection) — " +
        "use this tool, not that field, to detect orphaned rows.",
      inputSchema: strictInput({
        remove: z.boolean().optional().describe("delete orphaned rows instead of marking them missing (default false)"),
      }),
    },
    guard(async ({ remove }) => {
      const report = await store.docsPrune({
        ...(remove !== undefined ? { remove } : {}),
      });
      return json(report);
    }),
  );

  server.registerTool(
    "ground_health",
    {
      title: "Health",
      description: "Storage + embedding + record-count health report.",
      inputSchema: strictInput({}),
    },
    guard(async () => {
      const report = await store.health();
      return json(report);
    }),
  );

  return server;
}
