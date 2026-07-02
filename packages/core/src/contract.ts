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

export type FactStatus = "active" | "superseded" | "archived";

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
  /** stable dedupe/supersede key, e.g. "commit-no-ai-trailer". */
  topicKey?: string | null;
  pinned: boolean;
  /** 0..1 ranking boost. */
  importance: number;
  status: FactStatus;
  supersededBy?: number | null;
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
    /** target chunk size in characters. */
    chunkChars: number;
    /** chunk overlap in characters. */
    chunkOverlap: number;
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
  /** scope filter for facts/sessions, e.g. project name. */
  project?: string;
  /** force lexical-only even if embeddings are enabled. */
  lexicalOnly?: boolean;
}

export interface BriefOptions {
  agent?: string;
  project?: string;
  machine?: string;
  cwd?: string;
  /** optional query hint to bias related-docs selection. */
  query?: string;
  /** recent-session count (default 8). */
  recentSessions?: number;
  format?: "markdown" | "json";
}

export interface BriefResult {
  startupNote: string;
  recentSessions: Session[];
  facts: Fact[];
  relatedDocs: RecallResult[];
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
  /** dry-run: report what would change, write nothing. */
  dryRun?: boolean;
}

export interface IngestReport {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
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
  storage: { adapter: StorageAdapter; ok: boolean; detail?: string };
  embeddings: { provider: string; ok: boolean; dims: number; detail?: string };
  counts: { facts: number; sessions: number; docs: number };
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  project?: string;
  scope?: string;
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
  factsAdd(input: FactInput): Promise<Fact>;
  factsList(opts?: ListOptions): Promise<Fact[]>;
  factsGet(id: number): Promise<Fact | null>;
  factsDelete(id: number): Promise<boolean>;
  /** mark old fact superseded and insert the replacement; returns the new fact. */
  factsSupersede(oldId: number, replacement: FactInput): Promise<Fact>;

  // sessions
  sessionsAdd(input: SessionInput): Promise<Session>;
  sessionsList(opts?: ListOptions): Promise<Session[]>;
  sessionsGet(id: number): Promise<Session | null>;
  sessionsTimeline(opts: TimelineOptions): Promise<Session[]>;

  // docs
  docsIngest(rootPaths: string[], opts?: IngestOptions): Promise<IngestReport>;
  docsList(opts?: ListOptions): Promise<Doc[]>;
  docsGet(id: number): Promise<Doc | null>;
  /** mark/remove docs whose files no longer exist. */
  docsPrune(opts?: { remove?: boolean }): Promise<{ missing: number; removed: number }>;

  // retrieval
  recall(query: string, opts?: RecallOptions): Promise<RecallResult[]>;
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
