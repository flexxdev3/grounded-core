import { GroundedError } from "@grounded/core/contract";

/** One `[[databox.box]]` entry from config.toml. */
export interface BoxConfig {
  /** lowercase identifier used in routes, MCP calls and citations (`databox:<name>`). */
  name: string;
  /** the box folder: `<root>/items/**.json` written by an extractor; Databox adds `<root>/index/`. */
  root: string;
  /** one line for humans and the recall schema card: what the items are. */
  description?: string;
}

/**
 * Why a call failed, with the HTTP status a surface should answer. Codes:
 * DATABOX_DISABLED, DATABOX_UNAVAILABLE (DuckDB payload missing), DATABOX_NOT_FOUND,
 * DATABOX_SQL (the query is wrong), DATABOX_READ_ONLY (not a SELECT),
 * DATABOX_TIMEOUT, DATABOX_EMPTY (no items yet), DATABOX_BUILD (index build failed).
 */
export class DataboxError extends GroundedError {
  constructor(
    message: string,
    code: string,
    readonly status: 400 | 404 | 409 | 500 | 503 | 504,
  ) {
    super(message, code);
    this.name = "DataboxError";
  }
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableInfo {
  /** `<kind>.<table>`, or just `<table>` for items directly under `items/`. */
  name: string;
  /** DuckDB schema: the items subfolder, or "main". */
  kind: string;
  table: string;
  rows: number;
  columns: ColumnInfo[];
}

/** `<root>/index/current.json` — the pointer to the live index generation. */
export interface IndexPointer {
  /** generation id; the file is `index/<id>.duckdb`. */
  id: string;
  builtAt: string;
  buildMs: number;
  /** items fingerprint the generation was built from (path + size + mtime of every item). */
  fingerprint: string;
  files: number;
  bytes: number;
  tables: TableInfo[];
  /** Databox index format; a reader refuses a newer one and falls back to the JSON. */
  format: number;
  /** how this generation was made: only changed items re-read, or everything (and why). Absent on older pointers. */
  build?: { mode: "incremental"; changed: number; removed: number } | { mode: "full"; reason: string };
}

export type BoxState =
  /** index matches the items. */
  | "fresh"
  /** items changed since the index was built; answers come from the older index, flagged. */
  | "stale"
  /** items exist, no index yet; answers come straight from the JSON (slower). */
  | "unindexed"
  /** the folder or `items/` is missing or holds no item. */
  | "empty"
  /** the last build failed and there is no index to fall back on. */
  | "error";

export interface BoxStatus {
  name: string;
  root: string;
  description?: string;
  state: BoxState;
  building: boolean;
  items: { files: number; bytes: number; newestAt: string | null };
  index: Omit<IndexPointer, "tables" | "format"> & { tables: number; rows: number } | null;
  /** the last failed build, kept until a build succeeds. */
  lastError: { at: string; message: string } | null;
  /** top-level scalar fields of `<root>/manifest.json` when the extractor writes one (e.g. a game build number). */
  manifest: Record<string, string | number | boolean> | null;
}

export interface BoxSchema {
  box: string;
  description?: string;
  source: "index" | "json";
  stale: boolean;
  indexedAt: string | null;
  tables: TableInfo[];
  manifest: Record<string, string | number | boolean> | null;
}

export interface QueryOptions {
  /** rows returned (default 100, max 5000). `meta.available` still counts every row. */
  limit?: number;
  /** abort after this long (default 15 s, max 120 s). */
  timeoutMs?: number;
}

export interface QueryMeta {
  returned: number;
  /** rows the query produced before `limit` was applied. Exact unless `availableIsFloor`. */
  available: number;
  availableIsFloor: boolean;
  truncated: boolean;
  columns: ColumnInfo[];
  box: string;
  /** "index" = the DuckDB index; "json" = read straight from items/ (no index yet). */
  source: "index" | "json";
  /** true when items changed after the index was built: the answer may be out of date. */
  stale: boolean;
  indexedAt: string | null;
  elapsedMs: number;
  /** cite a conclusion as `citation` + `sql`: anyone can re-run it. */
  citation: string;
  sql: string;
}

export interface QueryResult {
  data: Record<string, unknown>[];
  meta: QueryMeta;
}

export const LIMIT_DEFAULT = 100;
export const LIMIT_MAX = 5000;
export const TIMEOUT_DEFAULT_MS = 15_000;
export const TIMEOUT_MAX_MS = 120_000;
export const BOX_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
