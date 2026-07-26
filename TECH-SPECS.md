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

[brief]
reserve = { vision = 400, facts = 900, sessions = 500 }
factCategoryFloors = { commit-rule = 1, convention = 2, playbook = 1 }
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

**Fact** (`contract.ts:21-52`): `id, scope, category, fact, detail?, topicKey?, pinned, importance(0..1),
status("active"|"archived"), origin("stated"|"derived"), createdBy?, source?, createdAt, updatedAt`.
`importance` defaults to `0.6` on insert (both adapters) — it feeds `factsList` ordering (`pinned desc,
importance desc, updated_at desc`); at `0` a defaulted fact sorted dead last. `status` is writable via
`factsAdd`/`factsUpdate` (`FactInput.status?: FactStatus`) — archiving is not deleting; `factsDelete`
remains a hard delete. `origin` defaults to `"stated"` on every current write path (human/agent asserting
the fact outright); `"derived"` is reserved for synthesis (Phase 8, not built) and no live caller sets it
— kept in a column, not a convention, so synthesis can never present an inference as operator truth.

`topicKey` is a per-scope upsert key among **active** rows only: `factsAdd` called with a `(scope,
topicKey)` matching an already-active fact routes to `factsUpdate` instead of inserting a second row —
**MERGE-PATCH semantics**, any field the caller omits keeps its stored value (`pinned`/`importance`
included — restating a pinned fact without repeating `pinned:true` does not unpin it). Archived rows are
exempt from the lookup and from the enforcing index, so a retired key can be reused by a fresh active
fact; asking `factsUpdate` to reactivate a fact into a key an active row already holds throws rather than
silently merging two facts. Enforced by a partial unique index, not just application logic — see §4.1/§4.2.

**Vision** (`contract.ts:60-76`): `id, scope("global"|"project:<name>"), summary(string|null),
details(markdown), createdBy?, source?, createdAt, updatedAt`. `details` is the narrative — recalled via
`ground_recall`/`/recall`, never injected. `summary` is the short form injected at SessionStart — never
recalled; a null `summary` (rows written before the column existed) falls back to truncated `details` for
injection (`visionInjectedText`, `brief.ts:191-193`), so no backfill was required. Exactly one record per
scope (`unique(scope)`); `visionSet` edits it in place, inserting only when none exists — no status, no
supersede, no history. **Excluded from recall** — no embedding, no FTS row, not a `SourceType`. Always
injected into the brief.

**Session** (`contract.ts:40-54`): `id, machine?, project?, workspace?, agent?, summary, details?,
tags?(string[]), source("manual"|"hook"|"import"|…), createdAt`.

**Doc** (`contract.ts:76-95`): `id, source, path, title, body, chunkIdx, totalChunks, bodyHash, mtime?,
status("active"|"archived"|"missing"), kind?, machine?, scope, ingestedAt`. `scope` is the doc **lane**
(default `"global"`), batch-level — every chunk from one `docsIngest` call carries the same scope
(`IngestOptions.scope`, §8). See §6.1 for how lanes interact with recall/brief defaults.

**RecallResult** (`contract.ts:89-107`): compact card — `sourceType, id, typedId, title, score,
matchedBy("vector"|"lexical"|"both"), createdAt?, updatedAt?, path?, source?, citation, snippet`
(snippet ≤ 200 chars). No full bodies.

**BriefResult** (`contract.ts:376-399`): `startupNote, vision({global, project} — Vision|null each),
recentSessions(Session[]), facts(Fact[]), relatedDocs(RecallResult[]), meta({vision, facts, sessions} —
each `DeliveryMeta`), droppedItems(TypedId[]), text?` (`text` filled when `format != "json"`). See §7 for
how `meta`/`droppedItems` are populated.

**`ListResult<T>` / `DeliveryMeta`** (`contract.ts:162-176`): every list-shaped `Store` method —
`factsList, sessionsList, docsList, visionList, recall, impact` — returns `{data: T[], meta: DeliveryMeta}`.
`DeliveryMeta = {returned, available, truncated, limit, bySource?}`. `available` is a real computed count
(a `count(*)` query, or an explicit accumulation for the recall/brief lanes) — **never** derived from
`data.length`; that is the defect this type exists to make structurally impossible. `truncated` means
"there may be more than `available`" as well as "more than `returned`" — see recall's lane-saturation
note (§6). `bySource` (recall/impact only) repeats the three fields per `SourceType`.
**One deliberate exception: `sessionsTimeline` returns a bare `Session[]`**, not `ListResult<Session>`
— it has window semantics (before/after an anchor), not limit/offset truncation, so there is nothing
`available`/`truncated` would mean for it. This is intentional; do not wrap it.

**Fact writes** (`FactWriteResponse = Fact & {delivery: DeliveryRank}`, `contract.ts:178-181`):
`POST /facts` and `PATCH /facts/:id` return the plain `Fact` plus a computed `delivery` position.
`DeliveryRank = {rank, ofActive, delivered, warning?}` (`contract.ts:178`), built by
`computeDeliveryRank(rank, ofActive, typicalFactLimit)` (`engine/delivery.ts`): `rank` is the fact's
1-based position in `factsList`'s own ordering within its scope + `active` status, `delivered` is
`rank <= typicalFactLimit` (`config.delivery.typicalFactLimit`, default `8` — mirrors the live hook's
`FACTS_LIMIT`), and past that threshold `warning` names the assumption the write violates. `delivery` is
omitted entirely — not nulled — when the written fact is archived (`Store.factsDeliveryRank` returns
`null`; an archived fact has no delivery position). `Store.factsAdd`/`factsUpdate` themselves return a
plain `Fact`; `FactWriteResponse` is assembled one layer up at the API/MCP surface (`app.ts:246-251`,
`server.ts:353-356`, §10/§11), computed via the separate `Store.factsDeliveryRank(id)` call.

**ImpactResult** (`contract.ts:343-357`): `Omit<RecallResult,"title"|"snippet"> & {title: string|null,
snippet: string|null, inScope: boolean, scope: string}`. `title`/`snippet` are `null` exactly when
`inScope` is `false` — content withheld across a doc-lane boundary; `path`/`citation`/`scope` always
survive, so the caller learns THAT a dependency exists and where, never silently dropped. Lane gating
applies to **docs only** — facts and sessions always report `inScope: true, scope: "global"` (a fact's
own `scope`, e.g. `"project:x"`, is a different axis and surfaces in `path`, exactly as in `recall()`).
See §6.2.

**Store interface** — 25 methods:
`init · visionGet · visionList · visionSet · visionDelete · factsAdd · factsList · factsGet ·
factsDelete · factsUpdate · factsDeliveryRank · sessionsAdd · sessionsList · sessionsGet ·
sessionsTimeline · docsIngest · docsList · docsGet · docsPrune · recall · impact · get · brief ·
health · close`.
`factsUpdate(id, patch: Partial<FactInput>)` edits a fact in place (re-embeds when the text changes) —
there is no separate supersede call. `factsDeliveryRank(id)` returns `{rank, ofActive} | null` (§ above);
it is a plain data query, not itself part of the `FactWriteResponse` wire shape.

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
  status, origin, created_by, source, created_at, updated_at)`
- `vision(id, scope, details, summary, created_by, source, created_at, updated_at)`
  — no FTS/vec rows (vision is injected, never searched). Pre-split cabinets get `content` renamed to
  `details` non-destructively (`migrateVisionSummarySplit`, `sqlite.ts:150-162`) plus a nullable `summary`
  column added; a null `summary` falls back to truncated `details` for injection (§3).
- `sessions(id, machine, project, workspace, agent, summary, details, tags, source, created_at)`
  — `tags` stored as serialized text.
- `docs(id, source, path, title, body, chunk_idx, total_chunks, body_hash, mtime, status, kind, machine,
  scope, ingested_at)` — `scope text not null default 'global'` (stage 3, `migrations/sqlite.ts:48`).
  Cabinets created before stage 3 get it via a one-shot guarded migration
  (`sqlite.ts:migrateAddDocsScope`): probe `pragma_table_info('docs')` for a `scope` column, and if
  absent, `alter table docs add column scope text not null default 'global'` + create the index. SQLite
  has no `ADD COLUMN IF NOT EXISTS`, hence the probe — the base `create table` above already includes the
  column for fresh cabinets, this path is only for pre-stage-3 ones.

**Indexes**: `facts(status)`, `facts(scope)`, `facts(topic_key)`,
`facts(scope, status, pinned desc, importance desc, updated_at desc)` (`idx_facts_rank`, covers
`factsList`'s own ordering), `sessions(project)`, `sessions(created_at)`, `docs(path)`, `docs(status)`,
`docs(scope)` (`idx_docs_scope`), **`docs(path, chunk_idx)` UNIQUE**, **`vision(scope)` UNIQUE** (the
one-record-per-scope invariant), **`idx_facts_topic_active_unique` on `facts(scope, topic_key) where
topic_key is not null and status='active'`** (`migrations/sqlite.ts:226-228`) — the partial unique index
that makes the `(scope, topicKey)` MERGE-PATCH upsert (§3) atomic rather than advisory; archived rows fall
outside it, so a retired key never blocks a fresh active row.

**Fact-identity backfill** (stage 2b, `sqlite.ts:185-228`), one-shot, runs before the index above is
created: for each pre-existing `(scope, topic_key)` collision among **active** rows, the newest row (by
`updated_at`) keeps the key; every older row in the group gets `topic_key` set to `null` — not deleted,
not archived, it survives intact and simply becomes unaddressable by that key. Without this, creating the
partial unique index on a cabinet with a pre-existing collision would fail outright and block `init()`.

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

**Indexes** (`migrations/postgres.ts:67-76`): same b-tree set as SQLite + `docs(scope)` (`idx_docs_scope`)
+ **`docs(path,chunk_idx)` UNIQUE** + GIN on each `search_tsv` (`idx_facts_tsv`, `idx_sessions_tsv`,
`idx_docs_tsv`) + **`idx_facts_topic_key` on `facts(scope, topic_key) where topic_key is not null and
status='active'`** (`migrations/postgres.ts:140-142`) — Postgres's equivalent of SQLite's
`idx_facts_topic_active_unique` (§4.1), same partial-unique semantics.

**`docs.scope` migration** (`migrations/postgres.ts:69-70`, stage 3): Postgres has native
`add column if not exists`, so it's a plain idempotent statement — no probe needed, unlike SQLite:
`alter table "{{SCHEMA}}".docs add column if not exists scope text not null default 'global'`.

**`facts.origin` migration** (`migrations/postgres.ts:79`, stage 2b): same idempotent shape —
`alter table "{{SCHEMA}}".facts add column if not exists origin text not null default 'stated' check
(origin in ('stated','derived'))`. The same fact-identity backfill as SQLite (§4.1) runs first
(`migrations/postgres.ts:81-96`) — MUST precede the `idx_facts_topic_key` create, or a cabinet with a
pre-existing active-row collision fails the migration outright.

**`factsAdd` upsert strategy** (`postgres.ts:159-170`): considered and rejected a single
`insert … on conflict (scope, topic_key) where topic_key is not null and status='active' do update …`
(verified it works against a real Postgres targeting the partial index) in favor of a transactional
`select … for update` + conditional insert/update — the same read-then-branch idiom SQLite uses. Reason:
a blind `ON CONFLICT` would have to compute the embedding before knowing whether the write collides,
paying an Ollama round trip on what may turn out to be a no-op text update; the explicit branch only
re-embeds when `fact`/`detail` text actually changed, matching `factsUpdate`'s existing guard.

**Recall SQL:**
- Lexical (`postgres.ts:492-495`): `ts_rank_cd(search_tsv, websearch_to_tsquery('english', $1))`,
  `where search_tsv @@ websearch_to_tsquery(...)`, order by rank.
- Vector (`postgres.ts:515`): `order by embedding <=> $1 limit N` (cosine-distance operator).

### 4.3 Ingest idempotency
Skip a chunk whose `body_hash` is unchanged → re-ingest is cheap. `docs(path, chunk_idx)` UNIQUE is the
upsert key on both adapters. A body-unchanged chunk whose batch tags (`source`/`kind`/`machine`/`scope`)
*did* change still gets a tag-only `UPDATE` (no re-embed) — this is `IngestReport.retagged` (§8), the cheap
path for moving a tree between lanes.

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

`recall()` returns `ListResult<RecallResult>` (§3) — `meta.available` is the true pre-cap match count,
`meta.bySource` breaks it down per `SourceType`. Truncation here has a subtlety beyond the usual
limit/offset case: source caps mean `available` can itself be a floor rather than an exact count when a
lane is saturated before ranking — the honesty rule is "never *under*-report", not "always exact".

### 6.1 Doc-lane scoping (stage 3)

Every doc row carries a `scope` (lane), e.g. `"global"` (default) or `"administration"`. Scoping is
**routing, not enforcement** on the self-hosted, open-core surface: `packages/api` has exactly one auth
concept — a single static `GROUNDED_API_TOKEN` — and `agent`/`scope` are self-declared by the caller, not
authenticated. That has not changed. Per-token scope gating (`api_tokens.scopes`) is now armed, but only
on the private hosted gateway (`@grounded/cloud`, §14, stage 4b) — see §14 for what it enforces and why
that does not contradict this paragraph.

- **`recall()`** (`RecallOptions.scopes`) and **`brief()`** (`BriefOptions.docScopes`) filter the doc lane
  and both default to `['global']` when the caller passes nothing (sqlite.ts:922, mirrored in postgres.ts).
  A caller that wants an extra lane must declare **both**: `["global","administration"]`. Declaring only
  `["administration"]` drops the default engineering corpus out of recall/brief entirely — this is the
  single most likely caller mistake.
- **`docsList()`** (`ListOptions.scope`/`scopes`) is **unfiltered by default** — omit both and every lane
  comes back. This is deliberate: the console's doc browser has to show every lane, not just `global`.
  Only `recall`/`brief` apply the `['global']` default; `docsList` never does.
- **`ListOptions.scope`/`scopes` now mean lane uniformly** across facts and docs. Breaking change from the
  pre-stage-3 shape, where `GET /docs?source=` was aliased onto `ListOptions.scope` — "scope" meant
  "source" for docs. `ListOptions` now carries an explicit `source?: string` (docs-only, logical
  source/collection) separate from `scope`/`scopes` (lane, facts and docs both).

### 6.2 Impact — `Store.impact()` (stage 4)

The reverse lookup: "what depends on `subject`?" — the pre-flight before stopping, removing, deleting, or
renaming infrastructure. **The only Store operation that crosses a lane boundary.** `recall()` is
filter-then-drop (out-of-lane docs never leave SQL); `impact()` is filter-then-flag (out-of-lane docs are
fetched and returned with content withheld, not dropped) — see `ImpactResult` (§3).

- **Lexical-only by construction, deliberately.** `ImpactOptions` has no `lexicalOnly` flag — there is
  nothing to toggle. `subject` is a literal token (a container name, a port, a path); a nearest-neighbour
  vector search would return things that merely *resemble* it, and a tripwire that fires on resemblance
  is worse than none. Works unchanged with `embeddings=none`.
- **Lane gating applies to docs only.** Facts and sessions are never laned — always `inScope: true,
  scope: "global"` regardless of `ImpactOptions.scopes`. A fact's own `scope` (e.g. `"project:x"`) is a
  different axis, filtered by `ImpactOptions.project`, exactly as in `recall()`.
  `ImpactOptions.scopes` defaults to `['global']` and controls which doc lanes' *content* the caller may
  see — it does not filter which hits come back.
- **`limit` is authoritative and overrides `recall.sourceCaps` for impact only** (`sqlite.ts:1247-1256`,
  mirrored in postgres.ts): impact builds a per-call config with `sourceCaps: {fact:limit, session:limit,
  doc:limit}`. Recall's caps are a ranking cap — a bounded top-N reading list — and must not bound a
  dependency pre-flight; "42 things depend on this, here are 10" is the wrong answer to give an agent
  about to delete something, even truthfully flagged `truncated:true`. Default `limit` is `20` (vs
  recall's `10`).
- **`meta.available` counts withheld (out-of-lane) hits too** — they were found, and a count that hid them
  would be the exact silent-omission defect `DeliveryMeta` exists to prevent.
- **Citations are chunk-grained**: `doc:{source}/{path}#chunk{N}` — no line numbers. Line-level citation
  was considered and deferred (no chunk-to-line map exists yet).

---

## 7. Brief assembly — `engine/brief.ts`

`assembleBrief` (`brief.ts:22-33`) returns `BriefResult`. Fact scopes derived from
`["global", agent:{a}?, project:{p}?, machine:{m}?]` (`deriveFactScopes`) — a fact scoped
`machine:arch1` only surfaces in briefs on arch1 (the `machine` field already flows through
`BriefOptions` from the API/MCP/hook). An explicit `factScopes` array overrides the derivation. Related docs come from
`recall(query ?? cwd, {sources:["doc"], limit:5})` when a hint exists (`sqlite.ts:834-836`).
Default recent-session count 8 (`contract.ts:209`).

**Reserved-slice budgeting** (Doctrine 3, `brief.ts:62-162`): each of `vision`/`facts`/`sessions` gets a
fixed token share (`cfg.brief.reserve.{vision,facts,sessions}`, chars÷4 approximation, `CHARS_PER_TOK=4`
— no BPE dependency, the engine has no tokenizer for this) and truncates **within its own slice only** —
a long facts section can never eat into the sessions budget. `truncateToReserve` (facts/sessions) consumes
items strictly in their existing significance order (pinned/importance/recency for facts, newest-first for
sessions); once the budget is exceeded everything after is dropped in order, never cherry-picked. The
first item in a lane is never dropped even if it alone exceeds the reserve — a single long pinned fact
must not produce an empty facts section. Vision has no addressable sub-items, so `truncateVisionSection`
truncates *text*, not rows: it cuts the **project** vision first, then **global** if still over budget,
appending an ellipsis. `meta.vision.returned`/`.available` are still **rows** (0–2) like every other lane;
the character arithmetic lives in `meta.vision.chars.{returned,available}`, and `truncated` is true when
text was cut even though both rows survived. The static preamble (header
+ startup note + vision apply-note) has its own fixed, non-configurable `PREAMBLE_RESERVE_TOK=200`
(`brief.ts:78`) — documented bookkeeping only, nothing to truncate.

`BriefResult.meta = {vision, facts, sessions}` (each `DeliveryMeta`, §3) and `BriefResult.droppedItems:
TypedId[]` — facts' dropped ids first, then sessions', in that order. `droppedItems` never includes vision
(no vision arm in `SourceType`/`TypedId`) or `relatedDocs` (unreserved — bounded only by `limit:5` + the
200-char snippet cap, no reserve/meta key of its own). The markdown renderer surfaces a drop as a
`droppedNote` line — `"… N more <kind> in scope, not shown this budget — ground_get any of: …"` — capped
at `MAX_NAMED_DROPPED=8` named ids so a very large drop can't itself blow the remaining budget it's
reporting on.

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

**`brief.factCategoryFloors`** (`Record<string, number>`, default `{ "commit-rule": 1, "convention": 2,
"playbook": 1 }`, `config.ts:44`) — `applyCategoryFloors(facts, floors)` (`engine/brief.ts`), a pure
function called immediately before the facts `truncateToReserve` step in `assembleBrief`. It is a
**reordering pre-pass, not a filter**: output is a strict permutation of the input. For each floored
category, the first `n` facts of that category (in their existing significance order) are lifted into a
guaranteed prefix ahead of the truncator; everything else follows in original order. Empty floors (`{}`)
is byte-identical to the pre-existing behavior — no SQL change, no migration, no new dependency; the
grouping happens in memory over the ≤200 rows `brief()` already fetches.

**The problem this fixes** (measured 2026-07-25, live homelab stack): the 8 pinned global facts cost 897
tokens against the 900-token `brief.reserve.facts` budget — the pinned band alone consumed the entire
reserve, so no unpinned fact could ever be delivered regardless of importance. A 45-token `commit-rule`
fact ranked 17th and had never once been delivered in a brief. With a `commit-rule` floor of 1, it is now
guaranteed a slot ahead of the truncation cut.

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

**`IngestOptions`** (`contract.ts:289-300`): `source?, kind?, machine?, scope?, dryRun?`. `scope` tags
every chunk from this call with a lane (default `"global"`) — batch-level, not per-file. `machine` was
already on `Doc` and persisted by both adapters, but stage 3 is the first release to expose it at the
API/MCP surfaces (`POST /docs/ingest`, `ground_docs_ingest` — §10, §11).

**`IngestReport`** (`contract.ts:302-312`): `scanned, added, updated, skipped, retagged, removed, paths`.
`retagged` counts chunks whose body was unchanged but whose batch tags (`source`/`kind`/`machine`/`scope`)
were rewritten via a tag-only UPDATE — no re-embed, no body/body_hash/total_chunks touch. Retagged chunks
do **not** appear in `paths`. `removed` is unrelated to disk state: it's stale chunk indexes inside a
file that shrank on re-chunk (e.g. a file that used to produce 5 chunks now produces 3 — the old chunks
3–4 rows are deleted). `removed: 0` is not a signal that no rows are orphaned on disk — reconciling against
disk is `docsPrune`, not `IngestReport`.

**`docsPrune`** (`Store.docsPrune(opts?: {remove?: boolean})`, `contract.ts:385`): reconciles doc rows
against files on disk — a path previously ingested but now missing from disk is marked `status:"missing"`
(default), or hard-deleted when `remove:true`. Returns `{missing, removed}`. Surfaced at `POST
/docs/prune` (§10) and `ground_docs_prune` (§11) — before stage 3 this method existed on the contract and
both adapters but had no caller.

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
(`GROUNDED_API_TOKEN`, `bin.ts:10`); off by default. `/health` and `/llms.txt` always exempt. Mismatch →
401 `{error:"unauthorized", code:"UNAUTHORIZED"}`.

**21 routes** (10 GET / 8 POST / 1 PATCH / 2 DELETE):

| Method | Path | Store call |
|---|---|---|
| GET | `/health` | `health` |
| GET | `/llms.txt` | static agent-facing manual (`llms.ts`), plain text/markdown |
| GET | `/openapi.json` | static OpenAPI 3.1 doc (`openapi.ts`) |
| GET | `/vision` `?scope&limit&offset` | `visionList` |
| POST | `/vision` | `visionSet` (201, edits the one record for the scope in place) |
| DELETE | `/vision/:id` | `visionDelete` |
| GET | `/facts` `?scope&scopes&limit&offset&status` | `factsList` (`scopes` comma-separated, takes precedence over `scope`) |
| POST | `/facts` | `factsAdd` (201, returns `FactWriteResponse` — §3) |
| DELETE | `/facts/:id` | `factsDelete` |
| PATCH | `/facts/:id` | `factsUpdate` (returns `FactWriteResponse` — §3) |
| GET | `/sessions` `?project&limit` | `sessionsList` |
| POST | `/sessions` | `sessionsAdd` (201) |
| GET | `/sessions/:id` | `sessionsGet` |
| POST | `/docs/ingest` | `docsIngest` — body `{paths[], source?, kind?, machine?, scope?, dryRun?}` |
| POST | `/docs/prune` | `docsPrune` — body `{remove?}` (optional; empty body → `{remove:false}`) |
| GET | `/docs` `?source&scope&scopes&limit&offset&documents` | `docsList` — `source` filters logical source/collection, `scope`/`scopes` filter lane; **unfiltered by default on both axes** (§6.1) |
| GET | `/docs/:id` | `docsGet` |
| POST | `/recall` | `recall` — body may include `scopes` (doc-lane filter, defaults `["global"]`) |
| POST | `/impact` | `impact` — body `{subject, limit?, sources?, project?, scopes?}` (field is `subject`, not `query` — §6.2) |
| POST | `/brief` | `brief` — body may include `docScopes` (defaults `["global"]`) |
| GET | `/get/:typedId` | `get` |

`/brief` and `/docs/prune` parse the body with `readJsonOptional` (`app.ts:186-196`), which reads the raw
text instead of gating on `content-length` — that header is absent on chunked transfer-encoding requests,
which previously made the body parse silently short-circuit to `{}` (200 OK, `docScopes`/`remove`
discarded). Every other POST route still uses the strict `readJson`, which throws `ValidationError` on
unparseable JSON.

**Error mapping** (`app.ts:294-312`): `ValidationError`→400, `NotFoundError`→404, `EmbedError`→503,
`StoreError`/`ConfigError`/`GroundedError`→500. Unknown path → 404 `{code:"NOT_FOUND"}`.

**`GET /facts` status default** (`app.ts:203-213`): `?status` defaults to `active` when omitted.
`archived` and `all` are the explicit filters; `all` is handled in the route and never forwarded to the
store as a literal status value. Any other value → 400. `POST /facts` and `PATCH /facts/:id` validate
`status` the same way (`app.ts:126,142`) — 400 on anything other than `active`/`archived`. `origin`, when
present in the body, is validated the same way — 400 on anything other than `stated`/`derived`
(`optFactOrigin`, `app.ts:94-102`); omitted defaults to `"stated"` at the store layer, not the route.

---

## 11. MCP surface — `@grounded/mcp`

`@modelcontextprotocol/sdk` `McpServer`, name `"grounded"` v0.1.0 (`server.ts:59-65`). Each tool wrapped in
`guard()` — `GroundedError` returned as error text, never thrown (`server.ts:36-43`).

**Transports** (`bin.ts:13-18`): stdio default (`StdioServerTransport`); if `GROUNDED_MCP_HTTP_PORT` set →
`StreamableHTTPServerTransport` (stateless, `sessionIdGenerator: undefined`) on `127.0.0.1`.

**15 tools:**

| Tool | Key inputs | Store call |
|---|---|---|
| `ground_recall` | `query, limit?, project?, sources?, lexicalOnly?, scopes?` | `recall` → cited cards + JSON (`scopes` filters the doc lane, defaults `["global"]`, §6.1) |
| `ground_impact` | `subject, limit?, project?, sources?, scopes?` | `impact` → cited cards + JSON, out-of-lane hits content-withheld not dropped (§6.2) |
| `ground_timeline` | `around?, query?, project?, window?` | `sessionsTimeline` (bare `Session[]`, not `ListResult` — §3) |
| `ground_get` | `typedId` (`^(fact\|session\|doc):\d+$`) | `get` |
| `ground_brief` | `agent?, project?, machine?, cwd?, query?, format?, docScopes?` | `brief` (`docScopes` filters related-docs lane, defaults `["global"]`, §6.1) |
| `ground_vision_get` | `project?` | `visionGet` ×2 → `{global, project}` |
| `ground_vision_set` | `details, summary?, scope?` | `visionSet` (`details` narrative markdown, `summary` short SessionStart form — §3) |
| `ground_facts_add` | `fact, scope?, category?, detail?, topicKey?, pinned?, importance?, status?, origin?` | `factsAdd` → `Fact & {delivery?}` (`topicKey` MERGE-PATCH upserts an active match — §3) |
| `ground_facts_update` | `id, fact?, scope?, category?, detail?, topicKey?, pinned?, importance?, status?, origin?` | `factsUpdate` → `Fact & {delivery?}` |
| `ground_facts_list` | `scope?, limit?, status?` (defaults to `"active"`; `"all"` returns every status) | `factsList` |
| `ground_facts_delete` | `id` | `factsDelete` |
| `ground_session_add` | `summary, details?, project?, agent?, machine?, tags?` | `sessionsAdd` |
| `ground_docs_ingest` | `paths[]≥1, source?, kind?, machine?, scope?, dryRun?` | `docsIngest` (`scope` tags the batch's lane, default `"global"`; `machine` newly exposed at this surface in stage 3) |
| `ground_docs_prune` | `remove?` (default false) | `docsPrune` → `{missing, removed}` — reconciles rows against disk; distinct from `IngestReport.removed` (§8) |
| `ground_health` | `{}` | `health` |

`ground_facts_add`/`ground_facts_update` compute `delivery` the same way the API does (§3/§10): a second
`store.factsDeliveryRank` call plus `computeDeliveryRank`, at the MCP layer (`server.ts:353-356,395-398`),
omitted when the written fact is archived.

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
with `health · recall · impact · brief · get · vision.{set,list,delete} · facts.{add,list,update,delete} ·
sessions.{add,list,get} · docs.{list,get,ingest,prune}` (`packages/client/src/index.ts:49-106`); each is one
`fetch` against the API, JSON in/out, throws `GroundedHttpError(status, code, message)` on non-2xx. Doc-lane
scoping mirrors the engine: `docs.list` stays unfiltered by default (`opts.scope`/`scopes` optional),
`recall`/`brief` default `scopes`/`docScopes` to `['global']`, `impact.scopes` defaults `['global']` for
CONTENT visibility only, never filtering hits (§6.1/§6.2). `client.impact(subject, opts)` mirrors the
Store signature — `subject`, not `query`. `facts.add`/`facts.update` return `FactWriteResponse` (§3).
Types-only dep on `@grounded/core/contract` (nothing from core loaded at runtime).

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
| default doc scope (lane) | `"global"` | `contract.ts:297`, `migrations/{sqlite,postgres}.ts` |
| default recall/brief doc scopes | `["global"]` | `sqlite.ts:922` (mirrored postgres.ts), §6.1 |
| default impact scopes (content) | `["global"]` | `sqlite.ts:1246` (mirrored postgres.ts), §6.2 |
| impact default limit | `20` (vs recall's `10`) | `contract.ts:313`, `sqlite.ts:1243` |
| brief reserve (vision/facts/sessions) | `400` / `900` / `500` tok | `config.ts:43` |
| brief default fact category floors | `commit-rule:1, convention:2, playbook:1` | `config.ts:44` |
| brief preamble reserve (fixed, not configurable) | `200` tok | `brief.ts:78` |
| typical fact delivery limit | `8` (mirrors hook `FACTS_LIMIT`) | `config.ts:46` |
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

**Per-token scope enforcement** (stage 4b, `gateway.ts:18-37`): `api_tokens.scopes` (`text[]`, default
`['read','write']`, `tokens.ts:52`) is now enforced at the gateway, ahead of the proxied `createApp(store)`
call. `scopeCheck(scopes, method)` rejects with **403** `{error, code:"FORBIDDEN"}` when a `grnd_…`
bearer token's scopes lack `"read"` (blocks every method — the deliberate-revocation case) or, for a
mutating method (`POST`/`PATCH`/`PUT`/`DELETE`), lack `"write"`. Session-cookie (browser console) auth is
untouched — `scopeCheck` only runs on the `grnd_…` token branch of `/api/*`'s resolver.

This is **hosted-only**. It does not change anything about self-host: `packages/api` still has exactly one
auth concept — a single static `GROUNDED_API_TOKEN` bearer, checked in full or not at all (§10) — and
`agent`/`scope` remain self-declared by the caller, not authenticated (§6.1). The line "routing, not
enforcement" describes the open-core surface specifically and remains true there; stage 4b adds a second,
separate enforcement point in the private gateway that open-core never sees or depends on.

---

*Reflects the implementation as of Phases 0–5 (engine + cli/api/mcp/client, hooks, install wiring; tests
green; locally installable) plus the hosted layer §14 (2026-07-13, `accounts` branch), doc-lane scoping
stage 3 (§6.1), the `ListResult`/`DeliveryMeta` delivery-accounting envelope (stage 2, §3/§7), `ground_impact`
(stage 4, §6.2/§10/§11), and cloud-gateway per-token scope enforcement (stage 4b, §14) — all 2026-07-25.
Behavioral guarantees live in [`CONTRACT.md`](packages/core/CONTRACT.md); roadmap in
[`../CLAUDE.md`](../CLAUDE.md).*
