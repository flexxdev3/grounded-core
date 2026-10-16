import type { DuckDBConnection } from "@duckdb/node-api";
import { ident, lit } from "./duck.js";
import type { KindScan, TypeHints } from "./items.js";
import type { ColumnInfo, TableInfo } from "./types.js";

/**
 * How a kind's JSON files become tables. Shared by the index build (into the
 * generation file) and the no-index fallback (into an in-memory database), so
 * the same SQL answers either way.
 *
 *   <kind>.items          one row per file: `_item` + every non-array field
 *   <kind>.<array key>    one row per array element: `_item`, `_n` (1-based
 *                         position), then the element's fields (array of
 *                         objects) or `value` (array of scalars)
 *
 * `_item` = the file's path under its kind folder without `.json`
 * (`items/cars/CAD_Escalade_21.json` -> `CAD_Escalade_21`).
 */

/** read_json options. sample_size=-1: infer from EVERY file, so a key that appears
 *  only in item 600 still gets a column instead of failing the build.
 *  maximum_object_size stays at DuckDB's 16 MB default: raising it sizes a read
 *  buffer per thread, and even 64 MB ran out of memory on a 46 MB / 638-file box
 *  with 32 threads (measured, 18.7 GiB limit). An item over 16 MB fails the
 *  build loudly, naming the limit: split it into smaller items. */
const READ_OPTS = "union_by_name = true, filename = '_databox_file', sample_size = -1";
const RAW = "_raw";

export interface MaterializeOpts {
  /** write the tables into this attached catalog (incremental build: the delta) instead of the default one. */
  catalog?: string;
  /** read only these files (absolute, forward slashes) instead of the kind's glob. */
  files?: string[];
  /** read with this exact raw schema (a previous build's) instead of inferring one. */
  columns?: ColumnInfo[];
  /** `<table>.<column>` -> DuckDB type, applied when a table is written. */
  hints?: TypeHints;
  /** collects every hint key that matched a column. */
  hintsUsed?: Set<string>;
}

export function readJsonSql(k: KindScan, o: Pick<MaterializeOpts, "files" | "columns"> = {}): string {
  // filename comes back with OS separators; strip the kind prefix by length and the extension.
  const item = `regexp_replace(substr(replace(_databox_file, '\\', '/'), ${k.prefix.length + 1}), '\\.json$', '', 'i')`;
  const source = o.files ? `[${o.files.map(lit).join(", ")}]` : lit(k.glob);
  const opts = o.columns
    ? `columns = {${o.columns.map((c) => `${lit(c.name)}: ${lit(c.type)}`).join(", ")}}, filename = '_databox_file'`
    : READ_OPTS;
  return `SELECT ${item} AS _item, * EXCLUDE (_databox_file) FROM read_json(${source}, ${opts})`;
}

/** The table a top-level array key becomes. `items` is taken by the per-file table. */
function arrayTableName(key: string): string {
  const t = key.replace(/[^A-Za-z0-9_]/g, "_");
  return t.toLowerCase() === "items" ? `${t}_list` : t;
}

export async function describe(conn: DuckDBConnection, relation: string): Promise<ColumnInfo[]> {
  const r = await conn.runAndReadAll(`DESCRIBE ${relation}`);
  return r.getRowObjectsJson().map((row) => ({ name: String(row["column_name"]), type: String(row["column_type"]) }));
}

const isStructList = (type: string) => type.startsWith("STRUCT(") && type.endsWith("[]");
const safe = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");

/** Child tables stop at this depth; deeper arrays stay as list columns (query them with unnest()). */
const MAX_DEPTH = 4;

/** Where a kind's tables go: `<catalog>.<schema>` or `<schema>`, plus the `/schema` name prefix hints use. */
interface Target {
  schema: string;
  /** `cars.` for a kind, empty for main. */
  prefix: string;
  kind: string;
  o: MaterializeOpts;
}

/**
 * Materialize one kind: `_raw` from the files, then `items` + one table per array key.
 * Returns the raw schema (without `_item`): an incremental build reads changed
 * files with exactly it, so the delta's tables match the index's.
 *
 * Intermediates (`_raw`, and a parent table while it still carries its child
 * arrays) are TEMP tables: they never reach the database file. Measured on the
 * FH6 catalogue (1.6 GB items): written as real tables then dropped, they left
 * 71% of the index as free blocks (985 MB file, 286 MB live) and their
 * checkpoints cost ~15 s of the 81.5 s build. Every user table is written once.
 */
export async function materializeKind(conn: DuckDBConnection, k: KindScan, o: MaterializeOpts = {}): Promise<ColumnInfo[]> {
  const schema = o.catalog ? `${ident(o.catalog)}.${ident(k.kind)}` : ident(k.kind);
  if (k.kind !== "main") await conn.run(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const t: Target = { schema, prefix: k.kind === "main" ? "" : `${k.kind}.`, kind: k.kind, o };
  const raw = tempName(k.kind, RAW);
  await conn.run(`CREATE TEMP TABLE ${raw.name} AS ${readJsonSql(k, o)}`);
  const cols = await describe(conn, raw.ref);

  const arrays = cols.filter((c) => c.type.endsWith("[]")).map((c) => c.name);
  await writeTable(conn, t, "items", raw.ref, arrays);

  const taken = new Set(["items"]);
  for (const c of cols) {
    if (!c.type.endsWith("[]")) continue;
    const table = arrayTableName(c.name);
    taken.add(table.toLowerCase());
    await explode(conn, t, raw.ref, c, table, [], taken, 1);
  }
  await conn.run(`DROP TABLE ${raw.ref}`);
  return cols.filter((c) => c.name !== "_item");
}

/** A TEMP table name unique per kind: `name` for CREATE TEMP TABLE, `ref` to read or drop it. */
function tempName(kind: string, table: string): { name: string; ref: string } {
  const name = ident(`_databox_${safe(kind)}_${table}`);
  return { name, ref: `temp.main.${name}` };
}

/** CREATE the user table `table` from `source` minus `exclude`, casting the columns hints name. */
async function writeTable(conn: DuckDBConnection, t: Target, table: string, source: string, exclude: string[]): Promise<void> {
  const casts: string[] = [];
  const key = `${t.prefix}${table}`;
  const mine = Object.entries(t.o.hints ?? {}).filter(([h]) => h.slice(0, h.lastIndexOf(".")) === key);
  if (mine.length) {
    const have = new Set((await describe(conn, `SELECT * FROM ${source} LIMIT 0`)).map((c) => c.name));
    for (const [h, type] of mine) {
      const col = h.slice(h.lastIndexOf(".") + 1);
      if (!have.has(col) || exclude.includes(col)) continue;
      casts.push(`CAST(${ident(col)} AS ${type}) AS ${ident(col)}`);
      t.o.hintsUsed?.add(h);
    }
  }
  const star =
    "*" +
    (exclude.length ? ` EXCLUDE (${exclude.map(ident).join(", ")})` : "") +
    (casts.length ? ` REPLACE (${casts.join(", ")})` : "");
  await conn.run(`CREATE TABLE ${t.schema}.${ident(table)} AS SELECT ${star} FROM ${source}`);
}

/**
 * One array column -> one table, one row per element:
 *   `_item`, the parent positions (`<parent array>_n`, outermost first), `_n`,
 *   then the element's fields (array of objects) or `value` (array of scalars).
 * An array of objects INSIDE the new table becomes its own child table
 * `<table>_<key>` the same way and leaves the parent:
 *   parts (_item, _n, ...) -> parts_matis (_item, parts_n, _n, ...)
 *                          -> parts_matis_params (_item, parts_n, matis_n, _n, ...)
 * Measured why: on the FH6 catalogue a second-level unnest (1.2M params inside
 * 318k MatIs inside 62k parts) took 3.4 s per query; a flat table is a column scan.
 *
 * `from` is a relation exposing `_item`, `keys` and the array column.
 */
async function explode(
  conn: DuckDBConnection,
  t: Target,
  from: string,
  col: ColumnInfo,
  table: string,
  keys: string[],
  taken: Set<string>,
  depth: number,
): Promise<void> {
  const c = ident(col.name);
  const lead = ["_item", ...keys.map(ident), "_n"].join(", ");
  // two unnests in one SELECT zip together: position + element.
  const inner =
    `SELECT _item, ${keys.map((k) => `${ident(k)}, `).join("")}` +
    `unnest(generate_series(1, len(${c}))) AS _n, unnest(${c}) AS _el FROM ${from}`;
  const struct = isStructList(col.type);
  const select = `(SELECT ${lead}, ${struct ? "_el.*" : "_el AS value"} FROM (${inner}))`;
  // bind-only DESCRIBE (LIMIT 0): which fields become child tables, before writing anything.
  const children =
    struct && depth < MAX_DEPTH ? (await describe(conn, `SELECT * FROM ${select} LIMIT 0`)).filter((x) => isStructList(x.type)) : [];
  if (children.length === 0) {
    await writeTable(conn, t, table, select, []);
    return;
  }

  const tmp = tempName(t.kind, table);
  await conn.run(`CREATE TEMP TABLE ${tmp.name} AS SELECT * FROM ${select}`);
  let key = `${safe(col.name)}_n`;
  while (keys.includes(key)) key += "_";
  const childKeys = [...keys, key];
  for (const cc of children) {
    let child = `${table}_${safe(cc.name)}`;
    while (taken.has(child.toLowerCase())) child += "_";
    taken.add(child.toLowerCase());
    // the child sees this table's `_n` under its key name (parts._n -> parts_n).
    const src = `(SELECT _item, ${keys.map((k) => `${ident(k)}, `).join("")}_n AS ${ident(key)}, ${ident(cc.name)} FROM ${tmp.ref})`;
    await explode(conn, t, src, cc, child, childKeys, taken, depth + 1);
  }
  await writeTable(conn, t, table, tmp.ref, children.map((x) => x.name));
  await conn.run(`DROP TABLE ${tmp.ref}`);
}

/** Every user-facing table with its columns and row count. */
export async function listTables(conn: DuckDBConnection, withCounts: boolean): Promise<TableInfo[]> {
  const r = await conn.runAndReadAll(
    `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
     WHERE table_catalog = current_database() AND table_name <> ${lit(RAW)}
     ORDER BY table_schema = 'main' DESC, table_schema, table_name, ordinal_position`,
  );
  const byTable = new Map<string, TableInfo>();
  for (const row of r.getRowObjectsJson()) {
    const kind = String(row["table_schema"]);
    const table = String(row["table_name"]);
    const name = kind === "main" ? table : `${kind}.${table}`;
    let t = byTable.get(name);
    if (!t) {
      t = { name, kind, table, rows: 0, columns: [] };
      byTable.set(name, t);
    }
    t.columns.push({ name: String(row["column_name"]), type: String(row["data_type"]) });
  }
  const tables = [...byTable.values()];
  if (withCounts) {
    for (const t of tables) {
      const c = await conn.runAndReadAll(`SELECT count(*)::DOUBLE AS n FROM ${ident(t.kind)}.${ident(t.table)}`);
      t.rows = Number(c.getRowObjectsJson()[0]?.["n"] ?? 0);
    }
  }
  return tables;
}
