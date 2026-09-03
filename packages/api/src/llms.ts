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
- **vision** — the direction. Injected at startup, never returned by recall. Hard-capped;
  see "How to write a vision".

If two lanes both fit, the more specific one wins and the other gets a pointer, not a copy.

## Read this before your first call

- **Every list endpoint returns an envelope**: \`{ "data": [...], "meta": {...} }\`.
  \`meta.available\` is the match count before the limit was applied, and on \`POST /recall\` it is
  a **FLOOR, not an exact total** — recall counts matches inside a candidate pool sized from the
  limit, so the SAME query reports a bigger \`available\` at a bigger limit (limit 1 -> 70,
  limit 30 -> 182). Read it as "at least this many matched", never as a budget for deciding
  whether to raise \`limit\`. \`meta.truncated\` tells you whether you are looking at a partial
  answer. Never infer "no results" from a short array —
  read \`meta\`. Tolerant parse if you may hit older instances: \`(.data? // .)\`.
  On \`POST /recall\`, \`limit\` is a **TOTAL across all sources**, not a per-type quota:
  \`limit: 5\` returns 5 rows in total, and \`meta.bySource[*].returned\` sums to \`meta.returned\`.
  Any one source may supply the whole answer if it out-scores the others — there is no per-type
  reservation and no hidden ceiling below the \`limit\` you asked for.
  \`limit\` must be an **integer in 1..200** (list routes: 1..5000). A fractional, zero, negative, or
  over-cap value is a **400**, never a silent clamp — page bulk reads with \`offset\` on
  \`/facts\`, \`/sessions\`, \`/docs\`.
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
- **Recall results are ordered by \`score\` descending across all types** — one ranked list, not
  fact/session/doc sections. Read \`score\`, not position-within-a-type; a doc can legitimately be
  row 1. If you want lanes, regroup client-side by \`sourceType\` after reading the list.
- **Ingest paths must be absolute on the server's filesystem.** A relative path or \`~\` returns
  \`scanned: 0\` with no error. If you get zero, check the path before checking anything else.
- Auth, when configured, is one bearer token: \`Authorization: Bearer <token>\`.
  \`/health\` and \`/llms.txt\` are exempt.

## Start here

Two calls cover most agent needs.

**Startup context** — call this once when a session begins:

\`\`\`
POST /brief
{ "agent": "<you>", "project": "<repo>", "cwd": "<abs path>", "format": "markdown",
  "timezone": "<your IANA zone>" }
\`\`\`

Returns vision + facts + recent sessions + related docs, each lane given a reserved token
budget so no lane can evict another. \`meta\` reports what was delivered per lane and
\`droppedItems\` names, by typed id, exactly which **facts and sessions** did not fit — so you
can fetch them with \`ground_get\`. **Vision is the one exemption**: it has no typed id, so it
truncates text instead of dropping rows and reports the cut in \`meta.vision.chars\` plus a
per-row account in \`meta.vision.rows[]\` (\`{ ref: "vision:12", scope, chars, clipped,
suppressedDetailChars }\`); \`ground_vision_get\` returns it in full. Nothing is withheld
without being either named or counted.
That truncation is now a **legacy path only** — the write cap means a newly written vision
always fits its reserve. A row still reporting \`truncated: true\` predates the cap and should
be trimmed at its next edit.

**A vision \`summary\` REPLACES \`details\` in the brief — it is not additive.** Setting a
summary on a row whose body was being injected blanks that body at startup. The brief now says
so: \`… vision:12 (project:x) shows its summary; N chars of details were not injected —
ground_vision_get returns them.\`, and the same count appears as
\`meta.vision.rows[].suppressedDetailChars\`.

**When the facts index tier engages it labels itself**: \`… N more facts compressed to index
lines (topic — trigger only) to fit the facts budget — ground_get for the full text:\`,
followed by the compressed lines. A compressed line is not a short fact; it is a clipped one.

**Pass \`timezone\`.** The session line carries a DATE ONLY, rendered UTC when you omit it.
West of UTC that means work logged in your local evening reads as TOMORROW, and you will
date your own recent history wrong. Display only — stored instants and the JSON
\`recentSessions[].createdAt\` are always UTC. An invalid zone is a 400, never a silent
fall back to UTC.

**Recall** — call this whenever you are about to assume something:

\`\`\`
POST /recall
{ "query": "<natural language>", "limit": 10, "scopes": ["global"] }
\`\`\`

Hybrid vector + lexical with reciprocal-rank fusion. Works with embeddings disabled — it
degrades to lexical, it does not fail. \`limit\` is the total row count you get back, ranked by
score across facts, sessions, and docs together — one strong source can fill all of it, so raise
it if you intend to regroup by type and want depth in every group.

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
  writes a new row. Capped — see "The budget contract".
- \`POST /sessions\` — log what happened. \`summary\` is the line an agent sees at startup;
  \`details\` is the body recall searches. Both capped — see "The budget contract".
- \`PATCH /sessions/:id\` — correct a work-log entry in place (partial; omitted fields keep
  their value). Use it instead of logging a second, contradicting row. \`DELETE /sessions/:id\`
  removes one outright. Every DELETE (\`/facts/:id\`, \`/sessions/:id\`, \`/vision/:id\`) is
  idempotent: 200 \`{deleted: true|false, id}\` — \`false\` means there was nothing to remove.
  An already-absent id is never a 404, so a retry cannot report a failure for a delete that
  succeeded.
- \`POST /docs/ingest\` — walks absolute paths, chunks, embeds, and delete-before-inserts
  changed files. Idempotent: unchanged files skip. A path that does not exist or cannot be
  read is a 400 (\`INGEST_PATH_UNREADABLE\`), never a 200 with \`scanned: 0\`.
- \`POST /vision\` — the direction. \`summary\` is injected at startup **instead of**
  \`details\`, not alongside it; \`details\` is neither injected nor recalled once a summary
  exists — read it back with \`GET /vision\`. **Both fields are capped** at
  \`brief.reserve.vision\` x 4 chars (**1600** on the shipped default); over it the write is
  rejected with a 400. See "How to write a vision".

Facts are never written by inference. Synthesis proposes; only an operator promotes.

## The budget contract

Every lane that feeds the startup brief is governed by ONE table, and both sides of it come
from the same numbers: the **read reserve** the brief truncates to, and the **write caps** your
POST/PATCH is checked against. No lane cap is stated anywhere else, and \`GET /health\`
publishes the table this service is actually enforcing (plus, per lane, how many stored rows
currently exceed it) — read it rather than assuming.

Shipped defaults:

| lane | field | over the row share | over the lane cap |
|---|---|---|---|
| vision | \`details\`, \`summary\` | — (one row IS the lane) | **400** over 1600 chars |
| facts | \`fact\` + \` — detail\` | warning at 450 chars | **400** over 3600 chars |
| sessions | \`summary\` | warning at 250 chars | **400** over 2000 chars |
| sessions | \`details\` | — (never injected) | **400** over 16000 chars |

Two tiers, on purpose:

- **Over the lane cap is a 400.** One row that consumes a whole lane leaves nothing for any
  other row in it. The error names the cap and how many chars to trim.
- **Over the per-row share is a warning, never a silent truncation and never a rejection.**
  Facts carry it in \`delivery.warning\`; sessions carry it in a \`budget\` object on the 201/200
  body (\`{ lane, warning, rowCapChars, laneCapChars, bodyCapChars }\`). The row IS stored — it
  is just eating a neighbour's slot in the brief.
- \`session.details\` is never injected into the brief (the lane renders summaries only), so it
  has no row share to exceed — only the ceiling. That is why a session log may be 8x longer
  than the lane that carries its summary.

Caps move with the reserve: raising \`brief.reserve.<lane>\` (or \`brief.budget.<lane>\`) in
\`config.toml\` raises what may be written and what may be delivered together. Nothing to edit
in two places — and nothing to guess, because /health prints the resolved result.

## How to write a fact

**A fact is one terse, dynamically-changing environment truth that must be on screen before
work starts.** One line, imperative, no rationale, no history. If it explains *how to use*
something, it is a pointer — name the doc, do not summarize it.

The facts lane has a **fixed token reserve**. It is written concurrently by every agent, so it
drifts toward paragraphs on its own, and long facts evict short ones. Discipline here is not
style, it is delivery:

- **Prose belongs in docs, mechanics belong in this file.** A fact links to both.
- **One fact, one truth.** Two truths are two facts with two \`topicKey\`s.
- **Revise, don't append.** Supply \`topicKey\` — the write is a merge-patch on
  \`(scope, topicKey)\`, so a rule is corrected in place. Omit it and you have added a
  near-duplicate that now competes with the original for the same reserve.
- **Delete what is done.** A fact describing a fixed problem is a to-do that outlived its fix.

**Check your write landed.** \`POST\`/\`PATCH /facts\` return a \`delivery\` block —
\`{ rank, ofActive, delivered, warning }\`. \`delivered: false\` means the fact you just wrote
will **not** be in the startup brief. Read it; do not assume a 200 means visible.

**What happens past the reserve**, in order: facts that fit render in full · the next ones
render as one compact index line each (\`topicKey — detail (fact:NN)\`) and are named in
\`indexedItems\` · anything past *that* is in \`droppedItems\` and is absent from
\`brief.text\` entirely. \`pinned\` is a **delivery guarantee**, not a ranking boost — the whole
pinned set survives the reserve, which is why pinning everything defeats it.

If facts are being dropped, **audit the lane before raising the reserve**. Terse facts make the
cliff unreachable; a bigger reserve only moves it.

## How to write a vision

**A vision is the objective and the committed next steps — nothing else.** It is the answer to
"what is this work FOR", not a record of what happened. It is injected at startup and never
recalled, so every char it spends is spent on every session in that scope.

\`details\` is **hard-capped at \`brief.reserve.vision\` x 4 chars — 1600 on the shipped
default.** Over the cap the write is REJECTED, not trimmed:

\`\`\`
400  details is 2802 chars, over the 1600-char vision cap. Vision carries objectives and
     committed next steps only -- history belongs in sessions, open defects in a HANDOFF
     doc. Trim 1202 chars.
\`\`\`

The cap is the vision lane's brief reserve, in chars. It is not a style preference: text past
the reserve was never delivered to anyone. Before the cap the overflow was cut silently at
read time, so an author could write 19k chars, see a 201, and never learn that the brief
handed agents the first 1600 and dropped the rest. Failing the write is the only moment the
author is still present to fix it.

What does NOT belong in a vision, and where it goes instead:

- **What happened** — a session (\`POST /sessions\`). This is the single biggest source of bloat:
  a vision edited as a changelog grows without bound.
- **Open defects, blockers, at-risk state** — a HANDOFF doc in the corpus.
- **How to do something** — a doc; the vision names it with a \`[[wikilink]]\`, never a summary.
- **Per-item status tables** — a STATE.md.

Editing is read-modify-write: \`GET /vision?scope=...\`, amend, POST the whole record back
(a set REPLACES the row in place). If that POST 400s, the row was already over cap — trim it
in the same edit rather than retrying.

**Raising the reserve is not the fix.** \`brief.reserve.vision\` raises the cap and the read
budget together, but every char it adds is taken from the startup window that facts and
sessions share. Audit the lane first.

## Docs and frontmatter

Frontmatter is **stripped, not parsed.** The engine removes a leading \`---\` block from the
indexed body so it never pollutes embeddings — and it reads **no key from it**. Concretely:

- \`status:\`, \`type:\`, \`updated:\` in a doc's frontmatter change **nothing**. A doc marked
  \`status: retired\` is still ingested, still recalled, still ranked.
- \`scope\` (the lane) is a **parameter of the ingest call**, not a document property.
- \`project\` is derived from the **path** (\`corpus/<project>/…\`); docs outside that
  convention get \`project: null\`.
- Retiring a doc means moving or removing it and running \`POST /docs/prune\`. Editing its
  frontmatter is a note to humans only.

Write frontmatter for your own conventions, but never rely on it to control retrieval.

## Keep the record honest

Recall ranks by relevance, and **relevance is not currency** — a confidently-ranked stale doc
is worse than no hit at all, because nothing signals it is wrong. The engine cannot detect
this; you can, because you are the one reading the content.

So, as you work: **when you find a doc, fact, or session that contradicts what you just
observed — say so, and offer to fix it.** Name the record by typed id, state the specific
drift, propose the correction, and let the operator decide. Do not silently work around it,
and do not rewrite operator content unasked.

Worth flagging when you see it: a doc describing a renamed or removed thing under its old name ·
a fact whose path, port, or command no longer resolves · a fact that is a to-do for something
already done · two records asserting different things about the same subject · a "next step"
that was finished in a later session.

Before you remove or rename anything, \`POST /impact\` first — it tells you what else refers to
it, so the fix lands everywhere instead of leaving the next agent a dangling reference.

## Full route list

| Method | Path | |
|---|---|---|
| GET | \`/health\` | liveness + counts + the resolved budget table and per-lane over-cap counts; auth-exempt |
| GET | \`/llms.txt\` | this document; auth-exempt |
| GET | \`/openapi.json\` | full schema for every route below |
| GET · POST · PATCH · DELETE | \`/facts\` \`/facts/:id\` | durable rules |
| GET · POST · DELETE | \`/vision\` \`/vision/:id\` | direction |
| GET · POST · PATCH · DELETE | \`/sessions\` \`/sessions/:id\` | work log |
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
