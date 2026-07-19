# @grounded/core — behavior contract

The frozen type surface is [`src/contract.ts`](src/contract.ts). This file specifies the **behavior**
every implementation must honor. API / MCP / installer depend only on the `Store` interface + these rules.

## Source-of-truth references
- Live recall mechanics, real schemas, embedding flow → repo [`AGENTS.md`](../../AGENTS.md) "live system" section.
- Roadmap + adaptability principles → repo [`CLAUDE.md`](../../CLAUDE.md).

## Records
Generalized from the live StuntLabs schemas: `facts` → `Fact`, `labwork` → `Session`,
`notes_corpus` → `Doc`. Keep semantics identical; only names are productized.

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

## Citations
Every `RecallResult` carries a `citation` and `typedId`. No result without a resolvable source.

## Errors
Throw `EmbedError` (embedding backend down), `StoreError` (storage failure), `ConfigError` (bad config).
Callers map these to exit codes / HTTP status. Lexical fallback is NOT an error.
