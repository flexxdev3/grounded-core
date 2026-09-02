/**
 * @grounded/core — public contract.
 *
 * This file is the FROZEN type + interface surface every package builds against.
 * Implementations (storage adapters, embedding providers, the recall engine, CLI/API/MCP)
 * must conform to these shapes. Do not add implementation here. See CONTRACT.md for behavior.
 */

// ---------------------------------------------------------------------------
// Records (generalized from the live StuntLabs schemas: facts / labwork / notes_corpus)
// ---------------------------------------------------------------------------

export type FactStatus = "active" | "archived";

/** Provenance of a fact. Synthesis writes `derived`; everything a human or an
 *  agent states outright is `stated`. Never inferred from context — a write
 *  path that cannot say which it is has no business writing a fact. */
export type FactOrigin = "stated" | "derived";

/** A durable hard rule / operator truth. Explicit memory. */
export interface Fact {
  id: number;
  /** "global" | "project:<name>" | "agent:<name>" etc. */
  scope: string;
  /** free-form bucket, e.g. "commit-rule", "homelab". */
  category: string;
  /** the rule itself (the sharp one-liner). */
  fact: string;
  /** optional elaboration / when-to-apply. */
  detail?: string | null;
  /** Stable identity key, e.g. "commit-no-ai-trailer". Unique per scope among
   * ACTIVE rows — writing the same (scope, topicKey) edits that fact in place
   * rather than creating a second competing row. Archived rows are exempt, so
   * a retired key can be reused. */
  topicKey?: string | null;
  pinned: boolean;
  /** 0..1 ranking boost. */
  importance: number;
  status: FactStatus;
  /**
   * How this fact came to exist. `stated` = written by an operator or agent
   * that meant it — every current write path. `derived` is reserved for
   * synthesis, which must never be able to present its inferences as operator
   * truth; keeping the distinction in a column (not a convention) is what makes
   * that guarantee checkable.
   */
  origin: FactOrigin;
  createdBy?: string | null;
  source?: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * The direction record — what all the work is FOR. Exactly one record per scope:
 * "global" (Global Vision) or "project:<name>" (Project Vision), edited in place
 * (unique on scope — no history, no supersede). Always injected into the brief;
 * never ranked by recall.
 */
export interface Vision {
  id: number;
  /** "global" | "project:<name>". */
  scope: string;
  /**
   * The short form injected at SessionStart. A null `summary`
   * falls back to truncated `details` for injection, so existing rows (written
   * before this column existed) keep working without a backfill.
   */
  summary: string | null;
  /** the vision itself — narrative markdown. Never recalled, never injected;
   *  read via visionGet/visionList (GET /vision) only. */
  details: string;
  createdBy?: string | null;
  source?: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/** A chronological work-log entry. Maps from `labwork`. */
export interface Session {
  id: number;
  machine?: string | null;
  project?: string | null;
  workspace?: string | null;
  agent?: string | null;
  /** one-line summary (<= ~80 chars). */
  summary: string;
  /** longer body / details. */
  details?: string | null;
  /** comma-or-array tags. Stored normalized as string[]. */
  tags?: string[] | null;
  source: string; // "manual" | "hook" | "import" | ...
  createdAt: string; // ISO-8601
}

export type DocStatus = "active" | "archived" | "missing";

/** An indexed document chunk. Maps from `notes_corpus`. */
export interface Doc {
  id: number;
  /** logical source/collection, e.g. "homelab" | "repo:grounded". */
  source: string;
  /** filesystem or logical path. */
  path: string;
  title: string;
  body: string;
  chunkIdx: number;
  totalChunks: number;
  /** content hash for idempotent ingest. */
  bodyHash: string;
  mtime?: string | null; // ISO-8601
  status: DocStatus;
  kind?: string | null; // "markdown" | "note" | ...
  machine?: string | null;
  /** lane, e.g. "global" | "administration". Batch-level only (see IngestOptions.scope). */
  scope: string;
  /** owning project, derived from the corpus/<project>/ path segment at
   * ingest (stage 4). Overridable by frontmatter `project:` at stage 5.
   * Null when no corpus/ segment is present -- never guessed. */
  project?: string | null;
  ingestedAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Recall (the cited return shape — progressive disclosure: compact card)
// ---------------------------------------------------------------------------

export type SourceType = "fact" | "session" | "doc";
export type MatchedBy = "vector" | "lexical" | "both";

/** A typed identifier like "fact:2", "session:274", "doc:1091". */
export type TypedId = `${SourceType}:${number}`;

/** Compact, cited recall result card. Full record fetched via Store.get(typedId). */
export interface RecallResult {
  sourceType: SourceType;
  id: number;
  typedId: TypedId;
  /** title (doc), summary (session), or the fact text. */
  title: string;
  /** fused relevance score (post-RRF, post-boost). Higher = better. */
  score: number;
  matchedBy: MatchedBy;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** doc path / session project / fact scope. */
  path?: string | null;
  source?: string | null;
  /** human-readable citation, e.g. "doc:homelab/network.md#chunk2". */
  citation: string;
  /** short matched excerpt for the card. */
  snippet: string;
}

/** Full record union returned by Store.get(). */
export type FullRecord =
  | { sourceType: "fact"; record: Fact }
  | { sourceType: "session"; record: Session }
  | { sourceType: "doc"; record: Doc };

// ---------------------------------------------------------------------------
// Delivery accounting — the launch-blocking signal: not just what was stored,
// but what actually reached the caller. Every list-shaped Store method returns
// this alongside its data so truncation is never silent.
// ---------------------------------------------------------------------------

export interface DeliveryMeta {
  /** rows that reached the caller. ALWAYS a row count — every lane, no
   * exceptions. A lane that truncates text rather than dropping rows reports
   * the character arithmetic in `chars`, never here. */
  returned: number;
  /** rows that matched before limit/offset/source-cap. A real computed quantity,
   * never derived from data.length. See recall()'s lane-saturation note for the
   * one case where this is a documented floor. */
  available: number;
  /** returned < available, OR text was cut inside a kept row (see `chars`), OR
   * the candidate fetch itself was capped before `available` could be computed
   * exactly — i.e. "there may be more than `available`", not just more than
   * `returned`. */
  truncated: boolean;
  limit: number | null;
  /** Only for lanes that truncate TEXT instead of dropping rows (today: the
   * brief's `vision` lane, whose budget is a char reserve and which has no
   * `SourceType` arm to drop into). `returned` is the post-truncation combined
   * char count, `available` the pre-truncation one. Absent on row-limited
   * lanes. Never mix these with the row counts above. */
  chars?: { returned: number; available: number };
  /** Facts lane only. Count of facts rendered as INDEX LINES (`topicKey —
   * detail (fact:NN)`) rather than full text — present when the reserve's
   * index tier rendered at least one such line, absent otherwise. `returned`
   * stays a count of full-text rows only; this is never folded into it. An
   * indexed fact is NOT in `droppedItems` (it survived, just compressed) —
   * see `BriefResult.indexedItems`. */
  indexed?: number;
  /** POST /recall only: per-source-type breakdown. `returned` is counted AFTER
   * the global limit cut (recall's `limit` is a total across sources), so
   * Σ bySource[*].returned === meta.returned always — MCP's meta line and the
   * console's chips render that sum literally. `available` is the pre-limit
   * candidate count for that lane, so `truncated` fires whenever the lane had
   * more to give or saturated its candidate window. */
  bySource?: Partial<Record<SourceType, { returned: number; available: number; truncated: boolean }>>;
}

export interface ListResult<T> { data: T[]; meta: DeliveryMeta; }

export interface DeliveryRank { rank: number; ofActive: number; delivered: boolean; warning?: string; }

/** Wire shape only — NOT the Store.factsAdd/factsUpdate return type. */
export type FactWriteResponse = Fact & { delivery: DeliveryRank };

// ---------------------------------------------------------------------------
// Embedding provider adapter
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** stable id, e.g. "ollama:nomic-embed-text" | "openai:text-embedding-3-small" | "none". */
  readonly id: string;
  /** vector dimensionality. 0 for the "none" provider (lexical-only). */
  readonly dims: number;
  /** true when this provider can actually produce vectors. */
  readonly enabled: boolean;
  /** embed a batch; returns one vector per input (empty array per input when disabled). */
  embed(texts: string[]): Promise<number[][]>;
  /** liveness check (e.g. ping Ollama). */
  health(): Promise<{ ok: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Configuration (mirrors config.toml)
// ---------------------------------------------------------------------------

export type StorageAdapter = "sqlite" | "postgres";
export type EmbeddingProviderName = "ollama" | "openai" | "none";

export interface GroundedConfig {
  /** cabinet home, e.g. ~/.grounded. */
  home: string;
  storage: {
    adapter: StorageAdapter;
    /** sqlite: file path. */
    path?: string;
    /** postgres: connection url or PostgREST base. */
    url?: string;
    /** postgres: schema (default "public"). */
    schema?: string;
  };
  embeddings: {
    provider: EmbeddingProviderName;
    baseUrl?: string;
    model?: string;
    dims?: number;
    apiKey?: string;
  };
  recall: {
    /** Reciprocal Rank Fusion constant. Default 60. */
    rrfK: number;
    /** max results returned per source type (anti-domination cap). */
    sourceCaps: Record<SourceType, number>;
    boosts: {
      /** multiplier for pinned facts. */
      pinned: number;
      /** weight applied to fact.importance (0..1). */
      importance: number;
      /** recency half-life in days for sessions. */
      recencyHalfLifeDays: number;
      /** multiplier for active (vs archived) docs. */
      activeStatus: number;
    };
  };
  ingest: {
    /** ignore-file name. Default ".groundignore". */
    ignoreFile: string;
    /** strip <private>...</private> blocks during ingest. */
    stripPrivate: boolean;
    /** strip leading YAML frontmatter from the indexed/embedded body during ingest. */
    stripFrontmatter: boolean;
    /** target chunk size in characters. */
    chunkChars: number;
    /** chunk overlap in characters. */
    chunkOverlap: number;
    /** path segment whose CHILD directory names the owning project, i.e.
     * `.../<projectSegment>/<project>/...`. A layout convention, not a
     * requirement: paths without the segment simply get a null project, and
     * `IngestOptions.project` overrides it either way. */
    projectSegment: string;
  };
  /**
   * Per-lane token reserves for `Store.brief()`. Each lane truncates within its
   * own reserve independently — a long facts section never eats into the
   * sessions budget. Units are tokens, approximated as chars÷4 (no BPE
   * dependency — the engine has no tokenizer and never will for this). The
   * static preamble/maps text (~200 tok) is NOT budgeted here — it's a fixed
   * `PREAMBLE_RESERVE_TOK` constant in engine/brief.ts, not configurable,
   * because it's not a truncatable lane.
   */
  brief: {
    reserve: {
      vision: number;
      facts: number;
      sessions: number;
    };
    /**
     * Minimum number of facts guaranteed a slot per `category`, applied
     * BEFORE the facts reserve is consumed — so a high-volume category (e.g.
     * many `homelab` facts) can't push every fact of a rarer but important
     * category (e.g. `commit-rule`) out of the truncated window. Categories
     * not listed have no floor. Optional — missing/omitted is treated as `{}`
     * (today's behavior, unchanged).
     */
    factCategoryFloors: Record<string, number>;
  };
  /**
   * `typicalFactLimit` mirrors the hardcoded `FACTS_LIMIT=8` in the live
   * SessionStart hook (`~/.claude/hooks/grounded-hook.sh`). It is the
   * threshold `computeDeliveryRank` uses to decide whether a fact's rank
   * warrants a warning — keeping the hook's assumption and the engine's
   * promise from drifting independently.
   */
  delivery: {
    typicalFactLimit: number;
  };
}

// ---------------------------------------------------------------------------
// Operation option/input shapes
// ---------------------------------------------------------------------------

export interface RecallOptions {
  /** total result limit across all sources (default 10). */
  limit?: number;
  /** restrict to these source types (default all). */
  sources?: SourceType[];
  /** workspace filter — applies to the session lane only (facts and docs have
   * no workspace dimension and are returned unfiltered, exactly as `project`
   * behaves). */
  workspace?: string;
  /** scope filter for facts/sessions, e.g. project name. */
  project?: string;
  /** force lexical-only even if embeddings are enabled. */
  lexicalOnly?: boolean;
  /**
   * Doc-lane scope filter: match any of these lanes (OR). Defaults to
   * `['global']` when omitted, so callers that declare nothing never see
   * non-global lanes (e.g. "administration") in recall results.
   */
  scopes?: string[];
}

/**
 * Options for `Store.impact()` — the reverse lookup ("what depends on X?").
 *
 * Deliberately has no `lexicalOnly` flag: impact is ALWAYS lexical. A subject
 * is a literal token (a container name, a port, a path), and a nearest-neighbour
 * search would return things that merely resemble it. A tripwire that fires on
 * resemblance is worse than none.
 */
export interface ImpactOptions {
  /** total result limit across all sources (default 20). */
  limit?: number;
  /** restrict to these source types (default all). */
  sources?: SourceType[];
  /** scope filter for facts/sessions, e.g. project name. */
  project?: string;
  /**
   * Doc lanes whose CONTENT the caller may see. Defaults to `['global']`.
   *
   * Unlike `RecallOptions.scopes`, this does NOT filter the result set — hits
   * in other lanes are still returned, with `inScope: false` and their content
   * withheld. That is the whole point: an agent about to delete something must
   * learn that an out-of-lane document depends on it, without that document's
   * contents leaking across the boundary.
   */
  scopes?: string[];
}

/**
 * One reverse-lookup hit. A `RecallResult` card plus the lane verdict.
 *
 * When `inScope` is false the card is citation-only: `title` and `snippet` are
 * null and `citation`/`path`/`scope` survive, so the caller learns THAT a
 * dependency exists and where to look, but not what it says.
 *
 * Lane gating applies to DOCS only. Facts and sessions are always `inScope:
 * true` — `scopes` means the doc lane everywhere else in the contract
 * (`RecallOptions.scopes`, `IngestOptions.scope`), and impact does not invent a
 * second meaning for it. A fact's `scope` ("global" / "project:x") is a
 * different axis and is filtered by `project`, exactly as in recall.
 */
export type ImpactResult = Omit<RecallResult, "title" | "snippet"> & {
  /** null when `inScope` is false — withheld across a lane boundary. */
  title: string | null;
  /** null when `inScope` is false — withheld across a lane boundary. */
  snippet: string | null;
  /** false only for docs outside `ImpactOptions.scopes`. */
  inScope: boolean;
  /**
   * The doc lane this hit lives in — always present, including when withheld.
   * Facts and sessions are not laned and always report `"global"`; a fact's own
   * `scope` ("project:x") is the other axis and is reported in `path`, exactly
   * as `recall()` does. Reporting it here would blur the two.
   */
  scope: string;
};

export interface BriefOptions {
  agent?: string;
  project?: string;
  machine?: string;
  cwd?: string;
  /** optional query hint to bias related-docs selection. */
  query?: string;
  /** recent-session count (default 8). */
  recentSessions?: number;
  /** explicit fact scope set; overrides the default global+agent+project derivation. */
  factScopes?: string[];
  /** explicit doc-lane scope set for the related-docs recall call. Explicit-only — no
   * agent/project/machine derivation. Defaults to `['global']` when omitted/empty. */
  docScopes?: string[];
  /** IANA zone (e.g. `America/Chicago`) the rendered session dates are expressed
   * in. Omitted → UTC, which is what every brief did before this existed.
   *
   * This is a DISPLAY concern only: stored instants are untouched, and the JSON
   * `recentSessions[].createdAt` stays full ISO-8601 UTC regardless. It matters
   * because the markdown line carries a DATE ONLY — for a caller west of UTC,
   * anything logged after local evening renders as tomorrow, which silently
   * misdates every "what did we do yesterday" judgement made off a brief. */
  timezone?: string;
  format?: "markdown" | "json";
}

/** True when `tz` is an IANA zone this runtime knows. `Intl` is the only
 * authority worth trusting — a hand-rolled regex would happily accept
 * `America/Nowhere`. Lives in contract, not the engine, so the API layer can
 * validate `BriefOptions.timezone` without importing the engine (and with it
 * every database driver) just to check a string. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface BriefResult {
  startupNote: string;
  /** the direction: Global Vision + the project's Vision (null when unset). */
  vision: { global: Vision | null; project: Vision | null };
  recentSessions: Session[];
  facts: Fact[];
  /** Related docs, ONE ROW PER FILE — the brief's recall call over-fetches
   * chunks and `dedupeDocsByPath` keeps the highest-scoring chunk of each
   * path, so a fixed slot is never spent re-citing a file already cited.
   * `/recall` itself is unchanged and still returns chunk-level rows. */
  relatedDocs: RecallResult[];
  /**
   * Delivery accounting per reserved lane. `vision` is measured in CHARS, not
   * items — there is no vision arm in `SourceType`/`TypedId`, so vision has no
   * per-item count to report and can never appear in `droppedItems` below.
   * `facts` and `sessions` are measured in items, truncated by the
   * `brief.reserve.*` token (chars÷4) budgets. `relatedDocs` deliberately gets
   * no reserve and no meta key — it has no row in Doctrine 3's reserve table
   * and is already bounded by 5 distinct docs + the 200-char snippet cap.
   */
  meta: { vision: DeliveryMeta; facts: DeliveryMeta; sessions: DeliveryMeta };
  /** typed ids of facts/sessions dropped by their lane's reserve, in the order
   * they were dropped. Never includes vision (no vision arm in SourceType) or
   * relatedDocs (unreserved). Each id resolves via Store.get(). */
  droppedItems: TypedId[];
  /** typed ids of facts rendered as INDEX LINES only (`topicKey — detail
   * (fact:NN)`) because they didn't fit the facts reserve's full-text budget
   * but did fit the index tier's own (smaller) budget — see
   * `FACTS_INDEX_MAX_TOK` in engine/brief.ts. These facts are NOT absent from
   * `brief.text` (that's what `droppedItems` means) — they're present in
   * compressed form so the agent knows they exist and can `ground_get` the
   * full record. Sessions have no index tier, so this only ever contains
   * `fact:` ids. */
  indexedItems: TypedId[];
  /** rendered text when format=markdown. */
  text?: string;
}

export interface FactInput {
  fact: string;
  scope?: string;
  category?: string;
  detail?: string;
  topicKey?: string;
  pinned?: boolean;
  importance?: number;
  status?: FactStatus;
  /** defaults to "stated". */
  origin?: FactOrigin;
  createdBy?: string;
  source?: string;
}

export interface VisionInput {
  /** narrative markdown. Recalled; never injected. */
  details: string;
  /** short form injected at SessionStart. Never recalled. Omitted/undefined
   * falls back to truncated `details` for injection. */
  summary?: string;
  /** "global" (default) | "project:<name>". */
  scope?: string;
  createdBy?: string;
  source?: string;
}

export interface SessionInput {
  summary: string;
  details?: string;
  project?: string;
  workspace?: string;
  agent?: string;
  machine?: string;
  tags?: string[];
  source?: string;
}

export interface IngestOptions {
  /** logical source label for the ingested docs. */
  source?: string;
  /** kind override. */
  kind?: string;
  machine?: string;
  /** lane, e.g. "global" (default) | "administration". Batch-level only — applies to
   * every chunk in this ingest call, not per-file. */
  scope?: string;
  /** owning project for every doc in this batch. Overrides the path-derived
   * project (see `ingest.projectSegment`) — set it when the tree does not
   * follow that layout, or when the caller already knows the project. */
  project?: string;
  /** dry-run: report what would change, write nothing. */
  dryRun?: boolean;
}

export interface IngestReport {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  /** batch tags (source/kind/machine/scope) changed on an otherwise-unchanged chunk:
   * a tag-only UPDATE ran, touching neither body, body_hash, total_chunks, nor embedding. */
  retagged: number;
  removed: number;
  paths: string[];
}

export interface TimelineOptions {
  /** anchor around this session id, or use query. */
  around?: number;
  query?: string;
  project?: string;
  /** number of entries before/after the anchor. */
  window?: number;
}

export interface HealthReport {
  ok: boolean;
  storage: { adapter: StorageAdapter; ok: boolean; detail?: string; location?: string };
  embeddings: { provider: string; ok: boolean; dims: number; detail?: string; model?: string };
  /**
   * `docs` counts chunks; `documents` counts distinct source files (chunk_idx = 0).
   * `bytes` is the on-disk size of the grounded tables+indexes (0 when unavailable).
   */
  counts: { facts: number; sessions: number; docs: number; documents: number; bytes: number };
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  project?: string;
  /** sessions only: filter by workspace. */
  workspace?: string;
  /** lane filter (facts and docs): match this scope. */
  scope?: string;
  /** lane filter (facts and docs): match any of these scopes (OR). Takes precedence over `scope`. */
  scopes?: string[];
  /** docs only: filter by logical source/collection (e.g. "homelab" | "repo:grounded").
   * Distinct from `scope`/`scopes`, which mean lane. */
  source?: string;
  status?: string;
  /** docs only: return one row per document (chunk 0) instead of every chunk. */
  documents?: boolean;
}

// ---------------------------------------------------------------------------
// Store — the repository interface every storage adapter implements.
// The recall engine and all surfaces (CLI/API/MCP) depend ONLY on this.
// ---------------------------------------------------------------------------

export interface Store {
  /** run migrations / ensure schema. Idempotent. */
  init(): Promise<void>;

  // facts
  /** Wire concern (rank) lives one layer up — see FactWriteResponse. Returns
   * the plain Fact so internal callers and the test suite never unwrap `.data`
   * for a write. */
  factsAdd(input: FactInput): Promise<Fact>;
  factsList(opts?: ListOptions): Promise<ListResult<Fact>>;
  factsGet(id: number): Promise<Fact | null>;
  factsDelete(id: number): Promise<boolean>;
  /** edit a fact in place; re-embeds when the text changes. Returns the updated
   * fact (plain `Fact`, not wrapped — see factsAdd's note). */
  factsUpdate(id: number, patch: Partial<FactInput>): Promise<Fact>;
  /**
   * Delivery rank for one fact: its 1-based position within `factsList`'s
   * ordering (`pinned desc, importance desc, updated_at desc`), scoped to the
   * fact's own `scope` and `status='active'`, plus `ofActive` (the count of
   * active facts in that scope). Returns null when the fact is missing or
   * archived. The `{...fact, delivery}` wire shape (`FactWriteResponse`) is
   * assembled at the HTTP/MCP layer from this + `computeDeliveryRank`, not here.
   */
  factsDeliveryRank(id: number): Promise<{ rank: number; ofActive: number } | null>;

  // vision — one active record per scope; edited in place; excluded from recall.
  visionGet(scope: string): Promise<Vision | null>;
  visionList(opts?: ListOptions): Promise<ListResult<Vision>>;
  /** upsert the active record for that scope in place (no lineage rows). */
  visionSet(input: VisionInput): Promise<Vision>;
  visionDelete(id: number): Promise<boolean>;

  // sessions
  sessionsAdd(input: SessionInput): Promise<Session>;
  sessionsList(opts?: ListOptions): Promise<ListResult<Session>>;
  sessionsGet(id: number): Promise<Session | null>;
  /** partial patch; omitted fields keep their stored value. Re-embeds and
   * re-indexes only when summary/details actually change. */
  sessionsUpdate(id: number, patch: Partial<SessionInput>): Promise<Session>;
  /** hard delete one session row (plus its index entries). false if absent. */
  sessionsDelete(id: number): Promise<boolean>;
  /** window semantics (before/after an anchor), not limit/offset truncation —
   * not wrapped in ListResult. */
  sessionsTimeline(opts: TimelineOptions): Promise<Session[]>;

  // docs
  docsIngest(rootPaths: string[], opts?: IngestOptions): Promise<IngestReport>;
  docsList(opts?: ListOptions): Promise<ListResult<Doc>>;
  docsGet(id: number): Promise<Doc | null>;
  /** mark/remove docs whose files no longer exist. */
  docsPrune(opts?: { remove?: boolean }): Promise<{ missing: number; removed: number }>;

  // retrieval
  recall(query: string, opts?: RecallOptions): Promise<ListResult<RecallResult>>;
  /**
   * Reverse lookup: "what depends on this subject?" — the pre-flight an agent
   * runs before stopping, removing or deleting infrastructure.
   *
   * Lexical-only by construction (see ImpactOptions), so it holds on the
   * zero-LLM path and with `embeddings=none`.
   *
   * **Crosses lane boundaries by design, and is the ONLY operation that does.**
   * `recall()` filters out-of-lane docs in SQL and never sees them
   * (filter-then-drop); `impact()` fetches them and flags them
   * (filter-then-flag), returning a citation with the content withheld. Recall's
   * behaviour is unchanged and must stay unchanged — the narrow bridge is here,
   * and only here, which is what keeps Doctrine 6 safe.
   *
   * `meta.available` counts withheld hits too: they were found, and a count that
   * hid them would be the exact silent-omission defect this contract exists to
   * remove.
   */
  impact(subject: string, opts?: ImpactOptions): Promise<ListResult<ImpactResult>>;
  get(typedId: TypedId): Promise<FullRecord | null>;
  brief(opts?: BriefOptions): Promise<BriefResult>;

  // ops
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GroundedError extends Error {
  constructor(message: string, readonly code: string = "GROUNDED_ERROR") {
    super(message);
    this.name = "GroundedError";
  }
}

export class EmbedError extends GroundedError {
  constructor(message: string) {
    super(message, "EMBED_ERROR");
    this.name = "EmbedError";
  }
}

export class StoreError extends GroundedError {
  constructor(message: string) {
    super(message, "STORE_ERROR");
    this.name = "StoreError";
  }
}

/** an ingest root that does not exist or cannot be read. Raised BEFORE any
 * write: answering `{"scanned": 0}` with a 200 for a path the server cannot
 * see is indistinguishable from an empty directory, and callers have had to
 * assert `scanned > 0` to catch it. */
export class IngestPathError extends GroundedError {
  constructor(readonly paths: string[]) {
    super(
      `ingest path${paths.length > 1 ? "s" : ""} not readable: ${paths.join(", ")}`,
      "INGEST_PATH_UNREADABLE",
    );
    this.name = "IngestPathError";
  }
}

export class ConfigError extends GroundedError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Factory contract (implemented in @grounded/core, consumed by CLI/API/MCP)
// ---------------------------------------------------------------------------

/** Open a Store from a resolved config. Implemented by core. */
export type OpenStore = (config: GroundedConfig) => Promise<Store>;

/** Load + resolve config (file < env < overrides). Implemented by core. */
export type LoadConfig = (overrides?: Partial<GroundedConfig>) => GroundedConfig;
