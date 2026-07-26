/**
 * The agent-facing manual for this Grounded instance, served verbatim at GET /llms.txt
 * (auth-exempt, alongside /health).
 *
 * Why this exists: agents were being taught how to call Grounded through Grounded's own
 * facts lane — the product spending its scarcest resource, the startup context window, to
 * document itself. This file is the pull-side answer. It costs zero startup tokens, an
 * agent fetches it the moment it needs to make a call, and one pointer replaces a wall of
 * standing rules.
 *
 * Scope boundary, enforced by review: this file owns MECHANICS (routes, shapes, gotchas).
 * It never carries operator truth — topology, credentials, house conventions, which
 * playbook to read when. That belongs in facts, scoped to the operator who wrote it.
 * Follows the llms.txt convention (llmstxt.org): one markdown file at a stable path.
 */
export const LLMS_TXT = `# Grounded

> Self-hosted continuity for multi-agent workspaces. Grounded gives coding agents a shared,
> source-cited memory layer — explicit facts, recent sessions, indexed docs, hybrid recall,
> and startup briefs. It runs offline, needs no LLM, and every item it returns is cited.

You are reading the manual for a **live Grounded instance**. Every path below is relative to
the base URL you fetched this from.

## The four lanes

Grounded separates memory by responsibility instead of inferring. Route what you write:

- **facts** — durable rules and operator truths. Explicit, small, always in the startup brief.
- **sessions** — what happened, chronologically. Written at the end of a work session.
- **docs** — what the operator wrote down. Ingested markdown, chunked and embedded.
- **vision** — the direction. Injected at startup, never returned by recall.

If two lanes both fit, the more specific one wins and the other gets a pointer, not a copy.

## Read this before your first call

- **Every list endpoint returns an envelope**: \`{ "data": [...], "meta": {...} }\`.
  \`meta.available\` is the true match count **before** the limit; \`meta.truncated\` tells you
  whether you are looking at a partial answer. Never infer "no results" from a short array —
  read \`meta\`. Tolerant parse if you may hit older instances: \`(.data? // .)\`.
- **\`scope\` / \`scopes\` mean LANE, not permission.** They partition content by audience.
  \`recall\` and \`brief\` default to \`["global"]\` — passing no scope silently excludes every
  other lane. Scoping is routing, not security: on a self-hosted instance a valid token reads
  everything.
- **Recall cards are truncated on purpose.** They are for choosing, not reading. Get the full
  record with \`GET /get/:typedId\`.
- **\`POST /recall\` answers in the same envelope** — cards are in \`.data\`, not \`.results\`. \`.meta.returned\`
  is the honest count, so \`meta.returned > 0\` with an empty read means you used the wrong key.
- **Recall card fields** (\`RecallResult\`, no \`.summary\`):
  - \`sourceType\` -> "fact" | "session" | "doc"
  - \`id\` / \`typedId\` -> numeric id / "type:id" (e.g. "doc:1091")
  - \`title\` -> doc title, session title, or the fact text (NOT \`summary\`)
  - \`score\` -> fused post-RRF/post-boost relevance, higher = better
  - \`matchedBy\` -> how it matched (vector/lexical/both)
  - \`citation\` -> human-readable source, e.g. "doc:homelab/network.md#chunk2"
  - \`snippet\` -> short matched excerpt
  - \`path\` / \`source\` -> doc path / session project / fact scope (nullable)
  - \`createdAt\` / \`updatedAt\` -> nullable timestamps
- **Ingest paths must be absolute on the server's filesystem.** A relative path or \`~\` returns
  \`scanned: 0\` with no error. If you get zero, check the path before checking anything else.
- Auth, when configured, is one bearer token: \`Authorization: Bearer <token>\`.
  \`/health\` and \`/llms.txt\` are exempt.

## Start here

Two calls cover most agent needs.

**Startup context** — call this once when a session begins:

\`\`\`
POST /brief
{ "agent": "<you>", "project": "<repo>", "cwd": "<abs path>", "format": "markdown" }
\`\`\`

Returns vision + facts + recent sessions + related docs, each lane given a reserved token
budget so no lane can evict another. \`meta\` reports what was delivered per lane and
\`droppedItems\` names, by typed id, exactly what did not fit — so you can fetch it if you
need it. Nothing is silently withheld.

**Recall** — call this whenever you are about to assume something:

\`\`\`
POST /recall
{ "query": "<natural language>", "limit": 10, "scopes": ["global"] }
\`\`\`

Hybrid vector + lexical with reciprocal-rank fusion. Works with embeddings disabled — it
degrades to lexical, it does not fail.

## Before you break something

\`\`\`
POST /impact
{ "subject": "<service, port, file, or name>" }
\`\`\`

Reverse lookup: what depends on this? Call it before stopping, removing, deleting, or
renaming anything. Lexical-only, so it works with no embeddings and no model. It is the one
operation that crosses lane boundaries — out-of-lane hits come back citation-only, with
\`path\` and \`citation\` intact and \`title\`/\`snippet\` null, so you learn that a dependency
exists without reading content you were not scoped to.

## Writing

- \`POST /facts\` — upserts on \`(scope, topicKey)\` as a **merge-patch**: omitted fields keep
  their existing value. Supply \`topicKey\` to revise a rule in place; omit it and every call
  writes a new row.
- \`POST /sessions\` — log what happened. \`summary\` is the line an agent sees at startup;
  \`details\` is the body recall searches.
- \`POST /docs/ingest\` — walks absolute paths, chunks, embeds, and delete-before-inserts
  changed files. Idempotent: unchanged files skip.
- \`POST /vision\` — the direction. \`summary\` is injected at startup and never recalled;
  \`details\` is recalled and never injected.

Facts are never written by inference. Synthesis proposes; only an operator promotes.

## Full route list

| Method | Path | |
|---|---|---|
| GET | \`/health\` | liveness; auth-exempt |
| GET | \`/llms.txt\` | this document; auth-exempt |
| GET | \`/openapi.json\` | full schema for every route below |
| GET · POST · PATCH · DELETE | \`/facts\` \`/facts/:id\` | durable rules |
| GET · POST · DELETE | \`/vision\` \`/vision/:id\` | direction |
| GET · POST | \`/sessions\` \`/sessions/:id\` | work log |
| POST | \`/docs/ingest\` \`/docs/prune\` | index management |
| GET | \`/docs\` \`/docs/:id\` | source browser |
| POST | \`/recall\` \`/impact\` \`/brief\` | the read surface |
| GET | \`/get/:typedId\` | full record, e.g. \`fact:87\`, \`session:455\`, \`doc:1204\` |

\`GET /openapi.json\` is authoritative for request and response shapes.

## If you are an MCP agent

The same engine is exposed as MCP tools over stdio or streamable HTTP, designed for
progressive disclosure: \`ground_recall\` returns compact cards, \`ground_get\` fetches one
record in full. Prefer that path — it is cheaper than raw HTTP for search-then-read.

## What Grounded will not do

It does not index source code — documentation only, by positioning. It does not run an LLM
in the write path. It does not require a vector database, a graph database, or a cloud
account. It does not remember anything you did not explicitly write.
`;
