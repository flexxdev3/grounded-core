import type { DuckDBInstance } from "@duckdb/node-api";
import { generationPath } from "./build.js";
import { requireDuck } from "./duck.js";
import type { ItemsScan } from "./items.js";
import { parseType, type DuckType } from "./incremental.js";
import { listTables, materializeKind } from "./plan.js";
import { DataboxError, type ColumnInfo, type TableInfo } from "./types.js";

/**
 * A read-only DuckDB handle on one box: either an index generation opened
 * READ_ONLY, or (no index yet) the same tables built from the JSON in memory.
 *
 * Every handle is sandboxed before a caller's SQL reaches it:
 * enable_external_access=false (no read_csv('/etc/...'), no COPY TO, no
 * ATTACH, no INSTALL) and lock_configuration=true (cannot be SET back).
 * Statement type is checked too: SELECT and EXPLAIN only.
 */
export interface Handle {
  key: string;
  source: "index" | "json";
  instance: DuckDBInstance;
  tables: TableInfo[];
  /** queries running on this handle; it closes when retired and idle. */
  busy: number;
  retired: boolean;
}

export async function openIndexHandle(root: string, id: string, tables: TableInfo[]): Promise<Handle> {
  const duck = await requireDuck();
  const instance = await duck.DuckDBInstance.create(generationPath(root, id), {
    access_mode: "READ_ONLY",
    enable_external_access: "false",
    lock_configuration: "true",
  });
  return { key: `index:${id}`, source: "index", instance, tables, busy: 0, retired: false };
}

export async function openJsonHandle(scan: ItemsScan): Promise<Handle> {
  const duck = await requireDuck();
  const instance = await duck.DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    // In-memory TABLEs, not VIEWs over read_json: every view re-scans the files
    // (measured 4.3 s for the first query on 638 items, 354 ms each after);
    // one in-memory build is ~0.8 s and queries then answer in ms. The handle
    // is keyed by the items fingerprint, so a change opens a fresh one.
    for (const k of scan.kinds) await materializeKind(conn, k, { hints: scan.hints });
    const tables = await listTables(conn, true);
    await conn.run("SET enable_external_access = false");
    await conn.run("SET lock_configuration = true");
    return { key: `json:${scan.fingerprint}`, source: "json", instance, tables, busy: 0, retired: false };
  } catch (err) {
    instance.closeSync();
    throw new DataboxError(`cannot read items as JSON: ${err instanceof Error ? err.message : String(err)}`, "DATABOX_BUILD", 500);
  } finally {
    conn.closeSync();
  }
}

export function retire(h: Handle): void {
  h.retired = true;
  if (h.busy === 0) closeQuietly(h);
}

function closeQuietly(h: Handle): void {
  try {
    h.instance.closeSync();
  } catch {
    /* already closed */
  }
}

/**
 * JSON-safe value: BIGINT/HUGEINT -> number when exact, else string; dates -> ISO; bytes -> base64.
 * With the column's type, FLOAT values (incl. inside lists/arrays/structs) print as the
 * shortest decimal that is the same float32 (0.011410641, not 0.011410640552639961);
 * DOUBLE values are never touched.
 */
export function toJson(v: unknown, type?: DuckType): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return type?.t === "scalar" && type.name === "FLOAT" ? shortestFloat32(v) : v;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map((x) => toJson(x, type?.t === "list" ? type.of : undefined));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJson(x, type?.t === "struct" ? type.fields.get(k) : undefined);
    return out;
  }
  return v;
}

export function shortestFloat32(x: number): number {
  if (Math.fround(x) !== x) return x;
  for (let p = 1; p <= 9; p++) {
    const y = Number(x.toPrecision(p));
    if (Math.fround(y) === x) return y;
  }
  return x;
}

const COUNT_CEILING = 10_000_000;

export interface RunResult {
  rows: Record<string, unknown>[];
  columns: ColumnInfo[];
  available: number;
  availableIsFloor: boolean;
}

export async function runQuery(h: Handle, sql: string, limit: number, timeoutMs: number): Promise<RunResult> {
  const duck = await requireDuck();
  h.busy++;
  const conn = await h.instance.connect();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    conn.interrupt();
  }, timeoutMs);
  try {
    const extracted = await conn.extractStatements(sql).catch((err: unknown) => {
      throw sqlError(err);
    });
    if (extracted.count !== 1) {
      throw new DataboxError(`send exactly one statement (got ${extracted.count})`, "DATABOX_SQL", 400);
    }
    const stmt = await extracted.prepare(0).catch((err: unknown) => {
      throw sqlError(err);
    });
    const t = stmt.statementType;
    if (t !== duck.StatementType.SELECT && t !== duck.StatementType.EXPLAIN) {
      throw new DataboxError("Databox is read-only: only SELECT (and EXPLAIN) statements run", "DATABOX_READ_ONLY", 400);
    }
    const result = await stmt.stream();
    const names = result.deduplicatedColumnNames();
    const columns = names.map((name, i) => ({ name, type: String(result.columnTypes()[i]) }));
    // parsed only where a FLOAT can hide: everything else converts untyped.
    const types = columns.map((c) => (c.type.includes("FLOAT") ? parseType(c.type) : undefined));
    const rows: Record<string, unknown>[] = [];
    let available = 0;
    let floor = false;
    for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      const n = chunk.rowCount;
      for (let r = 0; r < n && rows.length < limit; r++) {
        const values = chunk.convertRowValues(r, duck.JSDuckDBValueConverter);
        const row: Record<string, unknown> = {};
        names.forEach((name, i) => (row[name] = toJson(values[i], types[i])));
        rows.push(row);
      }
      available += n;
      if (available >= COUNT_CEILING) {
        floor = true;
        break;
      }
    }
    return { rows, columns, available, availableIsFloor: floor };
  } catch (err) {
    if (timedOut) throw new DataboxError(`query cancelled after ${timeoutMs} ms`, "DATABOX_TIMEOUT", 504);
    if (err instanceof DataboxError) throw err;
    throw sqlError(err);
  } finally {
    clearTimeout(timer);
    conn.closeSync();
    h.busy--;
    if (h.retired && h.busy === 0) closeQuietly(h);
  }
}

function sqlError(err: unknown): DataboxError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Permission Error|enable_external_access|lock_configuration/i.test(msg)) {
    return new DataboxError(`Databox queries cannot touch files or settings: ${msg}`, "DATABOX_READ_ONLY", 400);
  }
  return new DataboxError(msg, "DATABOX_SQL", 400);
}
