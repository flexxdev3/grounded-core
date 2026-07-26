# @grounded/core — behavior contract

The frozen type surface is [`src/contract.ts`](src/contract.ts). This file specifies the **behavior**
every implementation must honor. API / MCP / installer depend only on the `Store` interface + these rules.

## Source-of-truth references
- Live recall mechanics, real schemas, embedding flow → repo [`AGENTS.md`](../../AGENTS.md) "live system" section.
- Roadmap + adaptability principles → repo [`CLAUDE.md`](../../CLAUDE.md).

## Records
Generalized from the live StuntLabs schemas: `facts` → `Fact`, `labwork` → `Session`,
`notes_corpus` → `Doc`. Keep semantics identical; only names are productized.

## Delivery accounting (the envelope)
Every list-shaped method — `factsList`, `docsList`, `visionList`, `recall`, `impact` — returns
`ListResult<T> = { data: T[]; meta: DeliveryMeta }`. `meta.available` is a real computed count of what
matched, **never `data.length`** — a caller must be able to tell "there are more, capped by limit" from
"you saw everything." **Deliberate exception:** `sessionsTimeline` returns a bare `Session[]` — window
semantics (before/after an anchor), not limit/offset truncation, so it has no `meta` to report. That's
intentional; don't "fix" it into an envelope.

## Facts
- `origin: "stated" | "derived"`. Every current write path uses `stated`; `derived` is reserved for
  synthesis (never built yet — see CLAUDE.md Phase 8) and must never be presentable as operator truth.
- `(scope, topicKey)` is a partial-unique key over ACTIVE facts. Writing the same pair edits that fact
  in place — MERGE-PATCH semantics, omitted fields keep their existing value — instead of creating a
  competing row. Archived rows are exempt, so a retired `topicKey` can be reused.
- `factsDeliveryRank(id)` returns the fact's 1-based rank within its own scope's active `factsList`
  ordering (`pinned desc, importance desc, updated_at desc`) plus `ofActive`. The `{...fact, delivery}`
  wire shape (`FactWriteResponse`) is assembled one layer up (HTTP/MCP) from this + `computeDeliveryRank`.

## Vision (the direction lane)
`Vision` holds what the work is FOR — one narrative markdown record per scope:
- **Global Vision** (`scope="global"`) — what the whole operation is and where it's going.
- **Project Vision** (`scope="project:<name>"`) — where one project is going and why it exists.

Rules every adapter must honor:
- **One active record per scope.** `visionSet` inserts the new record as `active` and marks the prior
  active record for that scope `superseded` with `superseded_by` → new id (lineage kept, same as facts).
  There is no separate supersede call — set IS the supersede. Enforced by a partial unique index on
  `(scope) where status='active'`.
- **Always injected, never ranked.** Vision renders in every brief (see below) but is **excluded from
  recall** — `SourceType` stays `fact | session | doc`. No embedding, no FTS row.
- `visionGet(scope)` returns the one record for the scope or null; `visionSet` edits it in place
  (`unique(scope)`, no status/supersede/history). `visionList` supports a `scope` filter.
- `summary` (short, injected at SessionStart) and `details` (full narrative, recalled via `ground_recall`,
  never injected) are separate columns. A null `summary` falls back to truncated `details` for injection,
  so rows written before this column existed keep working without a backfill.

## Embedding providers
- `ollama` (default): `POST {baseUrl}/api/embeddings { model, prompt }` → `.embedding` (768 floats for
  `nomic-embed-text`). `baseUrl` default `http://localhost:11434`.
- `openai`: `POST {baseUrl}/v1/embeddings`. Default model `text-embedding-3-small` (1536 dims).
- `none`: `enabled=false`, `dims=0`, `embed()` returns `[]` per input → recall falls back to lexical-only.
- Dim is recorded with the store. **Switching the embedding model requires a re-embed** — never silently
  mix dims. On dim mismatch at open time, surface a clear error.

## Storage adapters (both implement `Store` identically)
- **sqlite** (default): one file. Tables `facts`, `sessions`, `docs`. Vectors in a `sqlite-vec` `vec0`
  virtual table (one per record type, keyed by rowid). Lexical via FTS5 external-content tables.
  Load the extension via the `sqlite-vec` npm `getLoadablePath()`; if it fails, set a capability flag and
  run lexical-only (same as `embeddings=none`) rather than crashing.
- **postgres**: `pgvector` columns + GIN `tsvector`. Mirrors the live `*_recall` RPC behavior. Connection
  via `url`. Schema default `public`.

Idempotent ingest: skip a chunk whose `bodyHash` is unchanged (this is why re-ingest is cheap).

## Hybrid recall (the heart — identical across adapters)
Given a query string:
1. If embeddings enabled and not `lexicalOnly`: embed the query once.
2. Run two lanes per source type:
   - **vector lane** — cosine similarity over the record's embedding (top N).
   - **lexical lane** — full-text rank (`bm25()` in SQLite FTS5 / `ts_rank_cd` over
     `websearch_to_tsquery` in Postgres) (top N).
3. **Fuse with Reciprocal Rank Fusion**: `score = Σ 1 / (rrfK + rank_in_lane)`, `rrfK` default 60.
   `matchedBy` = `both` when an item ranks in both lanes, else the single lane.
4. Apply **boosts**:
   - facts: `× boosts.pinned` if pinned; `× (1 + boosts.importance × importance)`.
   - sessions: recency decay using `boosts.recencyHalfLifeDays` (newer ranks higher).
   - docs: `× boosts.activeStatus` for active vs archived.
5. Apply **source caps** (`sourceCaps[type]`) so one source type can't dominate.
6. **Final answer order**: facts → recent sessions → active docs → historical docs. Within a tier, by score.
7. Return compact `RecallResult` cards (no full bodies). Full record via `Store.get(typedId)`.

If embeddings are disabled/unavailable, run lexical-only and set `matchedBy="lexical"`. Never error
just because embeddings are off — degrade gracefully.

**Doc lane scoping.** `RecallOptions.scopes` (default `['global']` when omitted) filters out-of-lane
docs in SQL — they never reach the caller (filter-then-drop). This is the one behaviour `impact()`
(below) deliberately does NOT share.

## Reverse lookup (`Store.impact`)
The pre-flight before stopping, removing, or renaming infrastructure — "what depends on this subject?"
A dependency tripwire, not a search; `subject` is a literal token (a container name, a port, a path),
not a natural-language query.
- **Lexical-only by construction** — there is no `lexicalOnly` option. A nearest-neighbour match on a
  literal token would surface resemblance, not dependency. Works with `embeddings=none`.
- **The only operation that crosses a lane boundary.** `recall()` filters out-of-lane docs in SQL and
  never sees them (filter-then-drop, unchanged by this feature). `impact()` fetches them and flags them
  instead (filter-then-flag): `title`/`snippet` are `null`, `citation`/`path`/`scope` survive, and
  `inScope: false` says why. Declaring the lane in `ImpactOptions.scopes` reveals the content.
- Lane gating is **docs-only** — facts and sessions are always `inScope: true`, `scope: "global"`.
- `meta.available` counts withheld hits too — hiding them would be the exact silent-omission defect this
  contract exists to prevent.
- `limit` is authoritative and overrides `recall.sourceCaps` for impact only (default 20, vs recall's 10).
- Citations are chunk-grained (`doc:{source}/{path}#chunk{N}`) — no line numbers.

## Progressive disclosure (MCP especially)
`recall` returns compact cards → caller picks `typedId`s → `sessionsTimeline`/`get` fetch detail only for
selected ids. Don't dump full bodies in `recall`.

## Brief (`Store.brief`)
Assemble scoped startup context, mirroring the live `labwork-hook.sh` shape:
```
=== STARTUP CONTEXT ===
<startupNote>
=== VISION (global · project:<p>) ===
<Global Vision content>
--- project:<p> ---
<Project Vision content>
Apply this: flag any plan, play, or design that conflicts with the vision before executing it.
=== MOST RECENT WORK (newest first) ===
<recent sessions, scoped by project if given>
=== DYNAMIC FACTS (curated · scope: global + agent:<a> + project:<p>) ===
<active facts, pinned/importance first>
=== RELATED DOCS ===
<top recall docs for the query/cwd hint, optional>
```
The VISION section is omitted entirely when no vision records exist (zero cost to non-adopters). The
`Apply this:` line is fixed — it is the instruction that makes vision *applied*, not just present.
`format=json` returns the structured `BriefResult`; `format=markdown` also fills `.text`.

Facts and sessions each truncate within their own `config.brief.reserve.*` token budget (chars÷4,
independent lanes — a long facts section never eats the sessions budget). Items dropped by that
truncation are listed in `BriefResult.droppedItems` (typed ids, resolvable via `Store.get`). `vision` is
measured in chars (no `SourceType` arm, so it never appears in `droppedItems`); `relatedDocs` is
unreserved — bounded only by its own `limit` + snippet length — and also never appears there.

**`brief.factCategoryFloors`** (`GroundedConfig.brief.factCategoryFloors: Record<string, number>`,
default `{ "commit-rule": 1, "convention": 2, "playbook": 1 }`) runs via the exported pure function
`applyCategoryFloors(facts, floors)` (`engine/brief.ts`), called immediately before the facts
`truncateToReserve` step. It is a **reordering pre-pass, not a filter**: the output is a strict
permutation of the input, never a subset. For each category with a floor `n`, the first `n` facts of
that category (in their existing significance order — pinned desc, importance desc, updated_at desc)
are lifted into a guaranteed prefix; every other fact follows after, in its original order. The
unmodified token-budget truncator then runs exactly as before. Empty floors (`{}`) is byte-identical to
prior behavior — this is the identity case, not a special-cased bypass.

## Citations
Every `RecallResult` (and `ImpactResult`, even when withheld) carries a `citation` and `typedId`. No
result without a resolvable source.

## Errors
Throw `EmbedError` (embedding backend down), `StoreError` (storage failure), `ConfigError` (bad config).
Callers map these to exit codes / HTTP status. Lexical fallback is NOT an error.
