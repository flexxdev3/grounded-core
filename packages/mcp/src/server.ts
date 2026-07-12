import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GroundedError } from "@grounded/core";
import type {
  Store,
  RecallResult,
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

const SOURCE_TYPES = ["fact", "session", "doc"] as const;

const TYPED_ID_RE = /^(fact|session|doc):\d+$/;

export function createServer(store: Store): McpServer {
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
      inputSchema: {
        query: z.string().describe("natural-language query"),
        limit: z.number().int().positive().optional().describe("total results across sources (default 10)"),
        project: z.string().optional().describe("scope filter for facts/sessions"),
        sources: z.array(z.enum(SOURCE_TYPES)).optional().describe("restrict to these source types"),
        lexicalOnly: z.boolean().optional().describe("force lexical-only (skip embeddings)"),
      },
    },
    guard(async ({ query, limit, project, sources, lexicalOnly }) => {
      const results = await store.recall(query, {
        ...(limit !== undefined ? { limit } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(sources !== undefined ? { sources: sources as SourceType[] } : {}),
        ...(lexicalOnly !== undefined ? { lexicalOnly } : {}),
      });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No results.\n\n[]" }] };
      }
      const cards = results.map(renderCard).join("\n\n");
      const body = `${cards}\n\n--- raw JSON (pick typedId) ---\n${JSON.stringify(results)}`;
      return text(body);
    }),
  );

  server.registerTool(
    "ground_timeline",
    {
      title: "Timeline",
      description: "Sessions around an anchor (session id or query). Use after ground_recall to expand context.",
      inputSchema: {
        around: z.number().int().optional().describe("anchor session id"),
        query: z.string().optional().describe("anchor by query instead of id"),
        project: z.string().optional(),
        window: z.number().int().positive().optional().describe("entries before/after the anchor"),
      },
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
      inputSchema: {
        typedId: z
          .string()
          .regex(TYPED_ID_RE, "expected <fact|session|doc>:<id>")
          .describe("typed id from a recall card"),
      },
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
      inputSchema: {
        agent: z.string().optional(),
        project: z.string().optional(),
        machine: z.string().optional(),
        cwd: z.string().optional(),
        query: z.string().optional().describe("bias related-docs selection"),
        format: z.enum(["markdown", "json"]).optional().describe("default markdown"),
      },
    },
    guard(async ({ agent, project, machine, cwd, query, format }) => {
      const opts: BriefOptions = {
        format: format ?? "markdown",
        ...(agent !== undefined ? { agent } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(machine !== undefined ? { machine } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(query !== undefined ? { query } : {}),
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
      inputSchema: {
        project: z.string().optional().describe("project name (loads its Project Vision too)"),
      },
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
        "Set the vision for a scope (narrative markdown). Supersedes the prior active record for that scope; lineage is kept.",
      inputSchema: {
        content: z.string().describe("the vision — narrative markdown"),
        scope: z.string().optional().describe('"global" (default) or "project:<name>"'),
      },
    },
    guard(async ({ content, scope }) => {
      const created = await store.visionSet({
        content,
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
      description: "Add a durable fact (explicit operator truth).",
      inputSchema: {
        fact: z.string().describe("the sharp one-liner rule"),
        scope: z.string().optional().describe('e.g. "global", "project:x", "agent:y"'),
        category: z.string().optional(),
        detail: z.string().optional().describe("elaboration / when-to-apply"),
        topicKey: z.string().optional().describe("stable dedupe/supersede key"),
        pinned: z.boolean().optional(),
        importance: z.number().min(0).max(1).optional().describe("0..1 ranking boost"),
      },
    },
    guard(async ({ fact, scope, category, detail, topicKey, pinned, importance }) => {
      const created = await store.factsAdd({
        fact,
        ...(scope !== undefined ? { scope } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(topicKey !== undefined ? { topicKey } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(importance !== undefined ? { importance } : {}),
      });
      return json(created);
    }),
  );

  server.registerTool(
    "ground_facts_list",
    {
      title: "List facts",
      description: "List active facts, pinned/importance first.",
      inputSchema: {
        scope: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    guard(async ({ scope, limit }) => {
      const facts = await store.factsList({
        ...(scope !== undefined ? { scope } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return json(facts);
    }),
  );

  server.registerTool(
    "ground_facts_delete",
    {
      title: "Delete fact",
      description: "Delete a fact by id.",
      inputSchema: { id: z.number().int().describe("fact id") },
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
      inputSchema: {
        summary: z.string().describe("one-line summary"),
        details: z.string().optional(),
        project: z.string().optional(),
        agent: z.string().optional(),
        machine: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
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
    "ground_docs_ingest",
    {
      title: "Ingest docs",
      description: "Ingest/index files or directories. Idempotent (bodyHash dedupe). Returns an IngestReport.",
      inputSchema: {
        paths: z.array(z.string()).min(1).describe("file or directory paths"),
        source: z.string().optional().describe("logical source label"),
        kind: z.string().optional(),
        dryRun: z.boolean().optional().describe("report changes without writing"),
      },
    },
    guard(async ({ paths, source, kind, dryRun }) => {
      const report = await store.docsIngest(paths, {
        ...(source !== undefined ? { source } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
      });
      return json(report);
    }),
  );

  server.registerTool(
    "ground_health",
    {
      title: "Health",
      description: "Storage + embedding + record-count health report.",
      inputSchema: {},
    },
    guard(async () => {
      const report = await store.health();
      return json(report);
    }),
  );

  return server;
}
