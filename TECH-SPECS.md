# grounded-core — technical specs

Implementation reference for the built engine + surfaces. Documents **what the code does** —
concrete schemas, config keys, formulas, route/tool tables — as of Phases 0–7 (service-first).

**Boundary with [`CONTRACT.md`](packages/core/CONTRACT.md):** the contract is the *normative* rule set
every `Store` implementation must honor (recall semantics, graceful degradation, citation guarantees).
This file is the *descriptive* map of the current implementation. When they overlap, CONTRACT.md wins on
"what must be true"; this file wins on "what the code currently is." Behavioral rules are **not** restated
here — they're linked.

Frozen type surface: [`packages/core/src/contract.ts`](packages/core/src/contract.ts).

---

## 1. Package layout

pnpm workspace, TypeScript + ESM. Everything depends on `@grounded/core`. Six **open-core** packages
below; a private **hosted layer** (§14) is documented separately.

| Package | Role | Key dirs |
|---|---|---|
| `@grounded/core` | engine: store contract, adapters, recall, ingest, brief, config, install snippets | `src/{storage,embedding,engine,ingest,install}` |
| `@grounded/cli` | `grounded` installer (commander) — install/manage the service + SessionStart hook scripts | `src/commands`, `src/util`, `hooks/` |
| `@grounded/api` | Hono REST + OpenAPI | `src/{app,bin,openapi}.ts` |
| `@grounded/mcp` | MCP server (stdio + streamable HTTP) | `src/{server,bin,installConfig}.ts` |
| `@grounded/client` | thin typed `fetch` wrapper over the API (types-only core dep) | `src/index.ts` |
| `@grounded/ui` | the console — small Preact web UI over the API (Recall · Facts · Sessions · Docs · Vision · Brief · Health) | `src/{views,components,styles}` |

Consumers (cli/api/mcp/client/ui) depend only on the `Store` interface + the record/option types in
`contract.ts`. The dependency-free install-snippet helpers live in `core` so the CLI can offer
`grounded mcp install` without pulling in the MCP SDK; `@grounded/mcp` re-exports them for back-compat.

---

## 2. Config (`config.toml`)

Parsed via `smol-toml`. File lives at `{home}/config.toml`. Shape → `contract.ts:139-184`,
defaults → `config.ts:10-42`.

```toml
[storage]
adapter = "sqlite"            # "sqlite" | "postgres"
path = "~/.grounded/cabinet/grounded.db"   # sqlite
# url = "postgres://…"        # postgres
# schema = "public"           # postgres

[embeddings]
provider = "ollama"           # "ollama" | "openai" | "none"
baseUrl = "http://localhost:11434"
model = "nomic-embed-text"
dims = 768
# apiKey = "…"                # openai only

[recall]
rrfK = 60
sourceCaps = { fact = 10, session = 10, doc = 10 }

[recall.boosts]
pinned = 1.5
importance = 1.0
recencyHalfLifeDays = 30
activeStatus = 1.25

[ingest]
ignoreFile = ".groundignore"
stripPrivate = true
stripFrontmatter = true
chunkChars = 1200
chunkOverlap = 150
```

**Default home:** `~/.grounded` (`config.ts:11`). **Default db:** `{home}/cabinet/grounded.db`.

**Load order** (`config.ts:107-117`): hardcoded defaults → `config.toml` → env vars → direct overrides →
`home` pinned to resolved value.

**Env overrides** (`config.ts:84-105`):

| Env var | Maps to |
|---|---|
| `GROUNDED_HOME` | `home` |
| `GROUNDED_STORAGE_ADAPTER` | `storage.adapter` |
| `GROUNDED_DB_URL` | `storage.url` |
| `GROUNDED_EMBED_PROVIDER` | `embeddings.provider` |
| `GROUNDED_EMBED_BASEURL` | `embeddings.baseUrl` |
| `GROUNDED_EMBED_MODEL` | `embeddings.model` |
| `GROUNDED_OPENAI_API_KEY` | `embeddings.apiKey` |

---

## 3. Records & types

Defined in `contract.ts`. All timestamps are ISO-8601 strings. Typed-id format:
`` `${SourceType}:${number}` `` where `SourceType = "fact" | "session" | "doc"` (`contract.ts:85`) —
e.g. `fact:2`, `session:274`, `doc:1091`.

**Fact** (`contract.ts:16-37`): `id, scope, category, fact, detail?, topicKey?, pinned, importance(0..1),
status("active"|"archived"), createdBy?, source?, createdAt, updatedAt`. `importance` defaults to `0.6`
on insert (both adapters) — it feeds `factsList` ordering (`pinned desc, importance desc, updated_at
desc`); at `0` a defaulted fact sorted dead last. `status` is writable via `factsAdd`/`factsUpdate`
(`FactInput.status?: FactStatus`) — archiving is not deleting; `factsDelete` remains a hard delete.

**Vision**: `id, scope("global"|"project:<name>"), content(markdown), createdBy?, source?, createdAt,
updatedAt`. Exactly one record per scope (`unique(scope)`); `visionSet` edits it in place, inserting only
when none exists — no status, no supersede, no history. **Excluded from recall** — no embedding, no FTS
row, not a `SourceType`. Always injected into the brief.

**Session** (`contract.ts:40-54`): `id, machine?, project?, workspace?, agent?, summary, details?,
tags?(string[]), source("manual"|"hook"|"import"|…), createdAt`.

**Doc** (`contract.ts:59-76`): `id, source, path, title, body, chunkIdx, totalChunks, bodyHash, mtime?,
status("active"|"archived"|"missing"), kind?, machine?, ingestedAt`.

**RecallResult** (`contract.ts:89-107`): compact card — `sourceType, id, typedId, title, score,
matchedBy("vector"|"lexical"|"both"), createdAt?, updatedAt?, path?, source?, citation, snippet`
(snippet ≤ 200 chars). No full bodies.

**BriefResult**: `startupNote, vision({global, project} — Vision|null each), recentSessions(Session[]),
facts(Fact[]), relatedDocs(RecallResult[]), text?` (`text` filled when `format != "json"`).

**Store interface** — 23 methods:
`init · visionGet · visionList · visionSet · visionDelete · factsAdd · factsList · factsGet ·
factsDelete · factsUpdate · sessionsAdd · sessionsList · sessionsGet · sessionsTimeline ·
docsIngest · docsList · docsGet · docsPrune · recall · get · brief · health · close`.
`factsUpdate(id, patch: Partial<FactInput>)` edits a fact in place (re-embeds when the text changes) —
there is no separate supersede call.

**Errors** (`contract.ts:332-358`): `GroundedError` (base, `code="GROUNDED_ERROR"`) →
`EmbedError("EMBED_ERROR")`, `StoreError("STORE_ERROR")`, `ConfigError("CONFIG_ERROR")`.
Callers map `code` → exit code / HTTP status.

---

## 4. Storage adapters

Both implement `Store` identically; only index primitives differ. Behavioral parity is a CONTRACT.md
requirement — this section documents the concrete DDL.

### 4.1 SQLite (default) — `storage/sqlite.ts`, `storage/migrations/sqlite.ts`

One file. Four base tables + FTS5 + vec0. Migrations at `migrations/sqlite.ts`.

**Base tables** (column names are snake_case; mapped to camelCase records):
- `facts(id INTEGER PK AUTOINCREMENT, scope, category, fact, detail, topic_key, pinned INT, importance REAL,
  status, created_by, source, created_at, updated_at)`
- `vision(id, scope, content, created_by, source, created_at, updated_at)`
  — no FTS/vec rows (vision is injected, never searched).
- `sessions(id, machine, project, workspace, agent, summary, details, tags, source, created_at)`
  — `tags` stored as serialized text.
- `docs(id, source, path, title, body, chunk_idx, total_chunks, body_hash, mtime, status, kind, machine,
  ingested_at)`

**Indexes**: `facts(status)`, `facts(scope)`, `facts(topic_key)`,
`sessions(project)`, `sessions(created_at)`, `docs(path)`, `docs(status)`, **`docs(path, chunk_idx)` UNIQUE**,
**`vision(scope)` UNIQUE** (the one-record-per-scope invariant).

**Lexical — FTS5 external-content** (`migrations/sqlite.ts:60-70`), `tokenize='porter unicode61'`:
- `fts_facts(fact, detail)` content=`facts`
- `fts_sessions(summary, details)` content=`sessions`
- `fts_docs(title, body)` content=`docs`

**Vector — sqlite-vec vec0** (`migrations/sqlite.ts:72-78`), `{{DIMS}}` substituted at runtime from
`embedder.dims`:
- `vec_facts / vec_sessions / vec_docs using vec0(embedding float[{{DIMS}}])`

**Extension load** (`sqlite.ts:79-97`): `sqliteVec.load(this.db)`; on failure set `vectorEnabled=false` and
run lexical-only — `health()` reports `"fts5 (lexical-only)"` (`sqlite.ts:854`). Never crashes.

**vec0 binding quirks** (the build learnings — easy to regress):
- Bind rowid as **BigInt**, embedding as a **JSON string** (`sqlite.ts:111-116`):
  `insert into {tbl}(rowid, embedding) values (?, ?)` ← `BigInt(id), JSON.stringify(vec)`.
- KNN needs an **explicit `and k = ?`** constraint (`sqlite.ts:595-605`):
  `select rowid, distance from {tbl} where embedding match ? and k = ? order by distance`.

### 4.2 Postgres (scale/homelab) — `storage/postgres.ts`, `storage/migrations/postgres.ts`

`pgvector` + generated `tsvector`. Schema default `"public"` (`postgres.ts:62`,
`cfg.storage.schema ?? "public"`). DDL at `migrations/postgres.ts:3-78`, `{{SCHEMA}}`/`{{DIMS}}` substituted.

Same logical columns as SQLite, plus per-table:
- `id bigint generated always as identity primary key`
- `embedding vector({{DIMS}})`
- `search_tsv tsvector generated always as (to_tsvector('english', …)) stored` — facts over
  `fact || detail`, sessions over `summary || details`, docs over `title || body`.
- `tags text[]` (native array, vs SQLite's serialized text), timestamps `timestamptz default now()`.
- `vision` mirrors the SQLite table (no embedding/tsv columns) with the same partial unique active index.

**Indexes** (`migrations/postgres.ts:67-76`): same b-tree set as SQLite + **`docs(path,chunk_idx)` UNIQUE** +
GIN on each `search_tsv` (`idx_facts_tsv`, `idx_sessions_tsv`, `idx_docs_tsv`).

**Recall SQL:**
- Lexical (`postgres.ts:492-495`): `ts_rank_cd(search_tsv, websearch_to_tsquery('english', $1))`,
  `where search_tsv @@ websearch_to_tsquery(...)`, order by rank.
- Vector (`postgres.ts:515`): `order by embedding <=> $1 limit N` (cosine-distance operator).

### 4.3 Ingest idempotency
Skip a chunk whose `body_hash` is unchanged → re-ingest is cheap. `docs(path, chunk_idx)` UNIQUE is the
upsert key on both adapters.

---

## 5. Embedding adapters — `embedding/`

Selected by `cfg.embeddings.provider` in `createEmbeddingProvider` (`embedding/index.ts:7-18`).
Each exposes `{ id, dims, enabled, embed(texts[]) }`.

| Provider | id | endpoint | request | response field | default model / dims | batching |
|---|---|---|---|---|---|---|
| `ollama` | `ollama:{model}` | `{baseUrl}/api/embeddings` | `{model, prompt}` | `.embedding` | `nomic-embed-text` / 768 | sequential per text |
| `openai` | `openai:{model}` | `{baseUrl}/v1/embeddings` | `{model, input[]}` | `data[].embedding` (by index) | `text-embedding-3-small` / 1536 | single batch request |
| `none` | `none` | — | — | — | — / 0 (`enabled=false`) | returns `[]` per input |

Defaults: ollama baseUrl `http://localhost:11434` (`ollama.ts:5-7`); openai baseUrl `https://api.openai.com`,
`apiKey` required (`openai.ts:5-7`). `none` health always `{ok:true, detail:"lexical-only"}` (`none.ts:12`).

Dim is recorded with the store; switching models is an explicit re-embed (CONTRACT.md rule), never silent.

---

## 6. Recall pipeline — `engine/recall.ts`

Concrete code path. Semantics/ordering rationale → CONTRACT.md §"Hybrid recall".

- **RRF** (`recall.ts:31-33`): `rrf(k, rank) = 1 / (k + rank)`, k from `recall.rrfK` (default 60).
- **fuseLane** (`recall.ts:39-92`): accumulate `score += rrf(k, rank)` across the vector lane then the
  lexical lane per item; `inVec`/`inLex` flags set `matchedBy` (`both` when in both).
- **Boosts** (`recall.ts:70-82`):
  - facts: `× boosts.pinned` if pinned (1.5); `× (1 + boosts.importance × importance)`.
  - sessions: `× recencyMultiplier(createdAt, halfLifeDays, now)`.
  - docs: `× boosts.activeStatus` (1.25) if active; no boost otherwise.
- **recencyMultiplier** (`recall.ts:95-105`): `0.5 ^ (ageDays / halfLifeDays)` — equals 0.5 at one
  half-life (default 30d); returns 1 for missing/invalid dates or `halfLifeDays ≤ 0`.
- **Source caps** (`recall.ts:90-91`): `fused.slice(0, sourceCaps[type])`.
- **Final order** (`orderResults`, `recall.ts:111-127`): tier 0 facts → 1 sessions → 2 active docs →
  3 archived/missing docs; within a tier, score desc.
- **Archived facts are excluded from recall entirely**, not demoted — both adapters filter fact
  candidates to `status='active'` before fusion/ranking. `archived` means *no longer true*, so it must
  not surface as truth; an archived fact stays reachable via `ground_get` / `factsGet` /
  `GET /facts?status=archived`. This is deliberately asymmetric with docs, which are *demoted* by the
  active-doc boost/tiering rather than excluded — an archived doc is history, an archived fact is a
  retracted rule.

Embeddings off/unavailable → lexical-only, `matchedBy="lexical"`, no error.

---

## 7. Brief assembly — `engine/brief.ts`

`assembleBrief` (`brief.ts:22-33`) returns `BriefResult`. Fact scopes derived from
`["global", agent:{a}?, project:{p}?, machine:{m}?]` (`deriveFactScopes`) — a fact scoped
`machine:arch1` only surfaces in briefs on arch1 (the `machine` field already flows through
`BriefOptions` from the API/MCP/hook). An explicit `factScopes` array overrides the derivation. Related docs come from
`recall(query ?? cwd, {sources:["doc"], limit:5})` when a hint exists (`sqlite.ts:834-836`).
Default recent-session count 8 (`contract.ts:209`).

Markdown render mirrors the live `labwork-hook.sh`, plus the vision section:
```
=== STARTUP CONTEXT ===
<startupNote>
=== VISION (global · project:Y) ===          (omitted when no vision records exist)
<Global Vision content>
--- project:Y ---
<Project Vision content>
Apply this: flag any plan, play, or design that conflicts with the vision before executing it.
=== MOST RECENT WORK (newest first) ===
=== DYNAMIC FACTS (curated · scope: global + agent:X + project:Y) ===
=== RELATED DOCS ===   (omitted when empty)
```
Both adapters' `brief()` fetch `visionGet("global")` + `visionGet("project:<p>")` (when project set).
`format=json` returns the structured object; `format=markdown` also fills `.text`.

Bodies are rendered, not just titles: fact `detail`, session `details`, and the related-doc `snippet`
are each whitespace-collapsed (`collapseWhitespace`, `brief.ts:39-41`) and appended after an em dash,
with the `(fact:N)` / `(session:N)` / doc citation suffix intact — see the `<Global Vision content>` block
above and the `- ${when}… ${summary}${details} (session:${s.id})` line shape.

---

## 8. Ingest — `ingest/`

**walker.ts** — indexable extensions `{.md, .markdown, .mdx, .txt}` (`walker.ts:15`); yields
`{absPath, relPath(posix), mtimeMs, sizeBytes}`.

**chunk.ts** — normalize CRLF/trim → split on blank lines (`/\n{2,}/`) → accumulate to `chunkChars`
(1200), hard-split oversized blocks, `chunkOverlap` 150 (`chunk.ts:31-77`). Per-chunk
`bodyHash = sha256(body, utf8)` (`chunk.ts:9-11`). `deriveTitle` (`chunk.ts:14-25`): first markdown
heading → else first non-empty line (≤120 chars) → else path.

**groundignore.ts** — gitignore-style. Default ignores: `.git, node_modules, .DS_Store, dist, build,
.cache, .venv, __pycache__` (`groundignore.ts:4-13`). Glob→regex: `*`→`[^/]*`, `**`→`.*`, `?`→`[^/]`;
`!` negation, trailing `/` dir-only, leading `/` root-relative (`groundignore.ts:26-77`).

**private.ts** — strip `` /<private>[\s\S]*?<\/private>/gi `` then collapse 3+ newlines to 2
(`private.ts:1-6`). Gated by `ingest.stripPrivate` (default true).

**frontmatter.ts** — split a leading YAML frontmatter block off the body before it is titled, chunked,
hashed, or embedded. Gated by `ingest.stripFrontmatter` (default true). Deliberately conservative: the
block must start on line 1 (a leading BOM is tolerated), close on a `---` or `...` fence line, **and
contain at least one `^key:` line** — otherwise the text is returned untouched, so a document that opens
with a `---` horizontal rule is never truncated. No YAML parsing and no dependency: this only removes the
block from the indexed text. Reading frontmatter *into* columns (`type`→`kind`, per-file `scope`) is a
later stage. `splitFrontmatter()` also returns the raw block for that stage to consume.

Why it matters: without it every doc's chunk 0 opens with ~15–25 tokens of near-identical
`type:/status:/updated:/project:/scope:` boilerplate, which pulls front-door chunks together in vector
space and dilutes each document's actual opening. Landed 2026-07-25 after a 250-doc frontmatter sweep
made the effect measurable.

---

## 9. Installer CLI surface — `@grounded/cli`

`commander`-based. Binary **`grounded`** (`bin.ts`), v0.1.0. **Service-first pivot:** the data verbs
(`facts/session/docs/recall/get/brief`) were removed — those operations now live on the service surface
(console / MCP / HTTP API §10–11). The CLI **never opens a store**; it stands up and manages the running
service. Install kit lives engine-side in `core/src/install/{bootstrap,detect,unit}.ts`.

**Global flags:** `--home <path>` (overrides `GROUNDED_HOME`), `--json` (machine output).
**Errors:** `error: <message>` on stderr, **exit 1**. `bin.ts` installs a stdout `EPIPE` handler so
`grounded … | head` exits cleanly.

| Command | Args / flags | What it does |
|---|---|---|
| `install` | `--port --method <docker\|systemd-user\|systemd-system> --image <ref> --token --yes --force` | preflight → detect running instance → dynamic method menu → `bootstrap()` → materialize backend → health-poll → write `install.json` |
| `status` | `--port` | `detect()` — running? how (docker/systemd/manifest)? `/health` counts. `--json` dumps the full `DetectResult` |
| `start` / `stop` / `restart` | — | resolve method via `detect()`/manifest → `docker`/`systemctl` lifecycle |
| `logs` | `-f/--follow` | `docker logs` or `journalctl` for the resolved backend |
| `uninstall` | `--purge --yes` | tear down container/unit + drop `install.json`; `--purge` also deletes the cabinet |
| `init` | — | low-level cabinet primitive → `bootstrap()` (also invoked inside `install`) |
| `mcp install` | `[target]` `--env KEY=VAL` `--all` | print MCP server config snippet (no store) |
| `mcp targets` / `hooks targets` | — | list targets |
| `hooks print` | `[target]` | print the SessionStart wrapper (curls `POST /brief`) + wiring |

**Install methods** (offered only when the host supports them — `util/preflight.ts` probes Docker daemon,
systemd user/system managers, npm, port): **docker** (image resolved local→pull→build, labelled
`com.grounded.managed`, `restart=unless-stopped`, `~/.grounded:/cabinet`), **systemd-user**
(`~/.config/systemd/user/grounded.service` via `npm i -g @grounded/api`), **systemd-system** (`/etc`, sudo).
Rendered by `core/src/install/unit.ts`. Interactive menu via `util/prompt.ts` (node `readline`, zero deps;
non-TTY auto-picks the default). Detection (`core/src/install/detect.ts`) is layered: `/health` fingerprint
+ docker label + `systemctl is-active` + `install.json` manifest — the double-install guard.

---

## 10. API surface — `@grounded/api`

Hono. `createApp(store, { token? }) → Hono` (`app.ts:1`). Same return shapes as the console/MCP (the contract types).

**Server** (`bin.ts`): `@hono/node-server`; port `GROUNDED_API_PORT` (default **7437**), host
`GROUNDED_API_HOST` (default `127.0.0.1`). SIGINT/SIGTERM graceful shutdown.

**Auth** (`app.ts:143-156`): bearer middleware active only when a token is set
(`GROUNDED_API_TOKEN`, `bin.ts:10`); off by default. `/health` always exempt. Mismatch → 401
`{error:"unauthorized", code:"UNAUTHORIZED"}`.

| Method | Path | Store call |
|---|---|---|
| GET | `/health` | `health` |
| GET | `/openapi.json` | static OpenAPI 3.1 doc (`openapi.ts`) |
| GET | `/vision` `?scope&limit&offset` | `visionList` |
| POST | `/vision` | `visionSet` (201, edits the one record for the scope in place) |
| DELETE | `/vision/:id` | `visionDelete` |
| GET | `/facts` `?scope&limit&offset&status` | `factsList` |
| POST | `/facts` | `factsAdd` (201) |
| DELETE | `/facts/:id` | `factsDelete` |
| PATCH | `/facts/:id` | `factsUpdate` |
| GET | `/sessions` `?project&limit` | `sessionsList` |
| POST | `/sessions` | `sessionsAdd` (201) |
| GET | `/sessions/:id` | `sessionsGet` |
| POST | `/docs/ingest` | `docsIngest` |
| GET | `/docs` `?source&limit&offset` | `docsList` |
| GET | `/docs/:id` | `docsGet` |
| POST | `/recall` | `recall` |
| POST | `/brief` | `brief` |
| GET | `/get/:typedId` | `get` |

**Error mapping** (`app.ts:294-312`): `ValidationError`→400, `NotFoundError`→404, `EmbedError`→503,
`StoreError`/`ConfigError`/`GroundedError`→500. Unknown path → 404 `{code:"NOT_FOUND"}`.

**`GET /facts` status default** (`app.ts:203-213`): `?status` defaults to `active` when omitted.
`archived` and `all` are the explicit filters; `all` is handled in the route and never forwarded to the
store as a literal status value. Any other value → 400. `POST /facts` and `PATCH /facts/:id` validate
`status` the same way (`app.ts:126,142`) — 400 on anything other than `active`/`archived`.

---

## 11. MCP surface — `@grounded/mcp`

`@modelcontextprotocol/sdk` `McpServer`, name `"grounded"` v0.1.0 (`server.ts:59-65`). Each tool wrapped in
`guard()` — `GroundedError` returned as error text, never thrown (`server.ts:36-43`).

**Transports** (`bin.ts:13-18`): stdio default (`StdioServerTransport`); if `GROUNDED_MCP_HTTP_PORT` set →
`StreamableHTTPServerTransport` (stateless, `sessionIdGenerator: undefined`) on `127.0.0.1`.

| Tool | Key inputs | Store call |
|---|---|---|
| `ground_recall` | `query, limit?, project?, sources?, lexicalOnly?` | `recall` → cited cards + JSON |
| `ground_timeline` | `around?, query?, project?, window?` | `sessionsTimeline` |
| `ground_get` | `typedId` (`^(fact\|session\|doc):\d+$`) | `get` |
| `ground_brief` | `agent?, project?, machine?, cwd?, query?, format?` | `brief` |
| `ground_vision_get` | `project?` | `visionGet` ×2 → `{global, project}` |
| `ground_vision_set` | `content, scope?` | `visionSet` |
| `ground_facts_add` | `fact, scope?, category?, detail?, topicKey?, pinned?, importance?, status?` | `factsAdd` |
| `ground_facts_update` | `id, fact?, scope?, category?, detail?, topicKey?, pinned?, importance?, status?` | `factsUpdate` |
| `ground_facts_list` | `scope?, limit?, status?` (defaults to `"active"`; `"all"` returns every status) | `factsList` |
| `ground_facts_delete` | `id` | `factsDelete` |
| `ground_session_add` | `summary, details?, project?, agent?, machine?, tags?` | `sessionsAdd` |
| `ground_docs_ingest` | `paths[]≥1, source?, kind?, dryRun?` | `docsIngest` |
| `ground_health` | `{}` | `health` |

**Install snippets** (`installConfig.ts`): `installSnippet(target, env?)` /
`allInstallSnippets(env?)` for targets `claude-code | codex | cursor | generic`. Server key `grounded`,
command `grounded-mcp`. Claude/Cursor/generic → JSON `{mcpServers:{grounded:{command,args,env}}}`; codex →
TOML `[mcp_servers.grounded]`. Returns `{target, label, file, snippet}`. Source of truth is now
`@grounded/core` `src/install/config.ts`; this file re-exports it (`installConfig.ts`).

---

## 12. Agent integration (Phase 5)

**Install snippets** — `installSnippet(target, env?)` / `allInstallSnippets(env?)` in
`core/src/install/config.ts`, targets `claude-code | codex | cursor | generic`. Surfaced by
`grounded mcp install [target] [--env KEY=VAL]` (print-only) and shipped as ready-made files in
`examples/configs/*`. A drift test (`core/src/install/config.test.ts`) asserts each example file
byte-matches `installSnippet(target).snippet`.

**SessionStart hooks** — shell wrappers in `packages/cli/hooks/` (shipped via package `files`):
- `grounded-session-start.sh` — Claude Code: reads hook JSON from stdin, derives agent/project/cwd,
  `curl`s `POST $GROUNDED_URL/brief` (format=markdown) failure-silent, extracts `.text`, emits
  `{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext}}`; on empty/error → `{}` + exit 0.
  Needs `jq` + `curl`.
- `grounded-session-start.generic.sh` — `curl`s the same endpoint and prints the brief markdown to stdout;
  uses `jq` to extract `.text` when present, raw JSON otherwise.
Surfaced by `grounded hooks print [target]` (resolves the shipped script via `import.meta.url` →
`../../hooks/`, prints script + per-target wiring). Env knobs: `GROUNDED_BIN`, `GROUNDED_AGENT`.

**Client lib** — `@grounded/client` `createClient({baseUrl, token?, fetch?, headers?}) → GroundedClient`
with `health · recall · brief · facts.{add,list} · sessions.{add,list} · docs.list`; each is one `fetch`
against the API, JSON in/out, throws `GroundedHttpError(status, code, message)` on non-2xx. Types-only dep
on `@grounded/core/contract` (nothing from core loaded at runtime).

**Local install** — `pnpm pack` each package (rewrites `workspace:*` → version) then
`npm i -g <all tarballs together>` puts `ground`/`grounded-api`/`grounded-mcp` on PATH (inter-deps resolve
from the set; `npm pack` does **not** work — leaves `workspace:*`). `pnpm smoke` (`scripts/smoke.sh`) runs
the full loop from `dist/`: build → init → seed → recall (none + ollama) → brief → mcp-install snippet →
hooks → grounded-mcp `tools/list`.

---

## 13. Constants quick-reference

| Item | Value | Source |
|---|---|---|
| config filename | `config.toml` | `config.ts:8` |
| default home | `~/.grounded` | `config.ts:11` |
| RRF k | `60` | `config.ts:26` |
| source caps | `fact/session/doc = 10` | `config.ts:27` |
| pinned boost | `1.5` | `config.ts:29` |
| importance weight | `1.0` | `config.ts:30` |
| recency half-life | `30` days | `config.ts:31` |
| active-doc boost | `1.25` | `config.ts:32` |
| chunk size / overlap | `1200` / `150` chars | `config.ts:38-39` |
| recent sessions in brief | `8` | `contract.ts:209` |
| snippet max | `200` chars | `sqlite.ts:767/785/802` |
| FTS tokenizer | `porter unicode61` | `migrations/sqlite.ts` |
| ollama default | `nomic-embed-text` / 768 | `embedding/ollama.ts:5-7` |
| openai default | `text-embedding-3-small` / 1536 | `embedding/openai.ts:5-7` |
| indexable exts | `.md .markdown .mdx .txt` | `ingest/walker.ts:15` |
| API port | `7437` | `api/bin.ts` |
| RRF formula | `1 / (k + rank)` | `recall.ts:32` |
| recency formula | `0.5 ^ (ageDays / halfLife)` | `recall.ts:104` |
| tier order | facts → sessions → active docs → archived docs | `recall.ts:115-119` |

---

## 14. Hosted layer — `@grounded/cloud` (commercial, private)

The managed-cabinet business layer lives in two **private, never-published** packages on the `accounts`
branch. It **consumes** open-core unchanged — `@grounded/core` never learns what a "user" is.

| Package | Role | Docs |
|---|---|---|
| `@grounded/cloud` | Hono gateway on OVH: `/auth/*` (better-auth) · `/account/*` (control plane) · `/api/*` (per-tenant proxy → `createApp(store)`) · serves the UI at `/`. Schema-per-tenant isolation, control-plane `accounts` schema, bounded Store LRU. | [`packages/cloud/DESIGN.md`](packages/cloud/DESIGN.md) |
| `@grounded/cloud-web` | the hosted-cabinet **account UI** (8 surfaces: Auth · Onboarding · Dashboard · Connect · API tokens · Cabinet · Settings · Billing). Preact + Vite, served by the gateway. | [`packages/cloud/web/TECH-SPECS.md`](packages/cloud/web/TECH-SPECS.md) |

Open-core boundary: everything account/multi-tenant is in `@grounded/cloud` (`private: true`), out of
`pnpm publish -r`. The per-tenant `/api/*` exposes the **same** routes a self-hoster runs — only base
URL + token differ.

---

*Reflects the implementation as of Phases 0–5 (engine + cli/api/mcp/client, hooks, install wiring; tests
green; locally installable) plus the hosted layer §14 (2026-07-13, `accounts` branch). Behavioral
guarantees live in [`CONTRACT.md`](packages/core/CONTRACT.md); roadmap in [`../CLAUDE.md`](../CLAUDE.md).*
