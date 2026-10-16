import type { DuckDBConnection } from "@duckdb/node-api";
import { ident, lit } from "./duck.js";
import type { KindScan } from "./items.js";
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

export function readJsonSql(k: KindScan): string {
  // filename comes back with OS separators; strip the kind prefix by length and the extension.
  const item = `regexp_replace(substr(replace(_databox_file, '\\', '/'), ${k.prefix.length + 1}), '\\.json$', '', 'i')`;
  return `SELECT ${item} AS _item, * EXCLUDE (_databox_file) FROM read_json(${lit(k.glob)}, ${READ_OPTS})`;
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

/** Materialize one kind: `_raw` from the files, then `items` + one table per array key, then drop `_raw`. */
export async function materializeKind(conn: DuckDBConnection, k: KindScan): Promise<void> {
  const s = ident(k.kind);
  if (k.kind !== "main") await conn.run(`CREATE SCHEMA IF NOT EXISTS ${s}`);
  await conn.run(`CREATE TABLE ${s}.${RAW} AS ${readJsonSql(k)}`);
  const cols = await describe(conn, `${s}.${RAW}`);

  const scalar = cols.filter((c) => !c.type.endsWith("[]")).map((c) => ident(c.name));
  await conn.run(`CREATE TABLE ${s}."items" AS SELECT ${scalar.join(", ")} FROM ${s}.${RAW}`);

  const taken = new Set(["items"]);
  for (const c of cols) {
    if (!c.type.endsWith("[]")) continue;
    const table = arrayTableName(c.name);
    taken.add(table.toLowerCase());
    await explode(conn, s, `${s}.${RAW}`, c, table, [], taken, 1);
  }
  await conn.run(`DROP TABLE ${s}.${RAW}`);
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
  s: string,
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
  await conn.run(`CREATE TABLE ${s}.${ident(table)} AS SELECT ${lead}, ${struct ? "_el.*" : "_el AS value"} FROM (${inner})`);
  if (!struct || depth >= MAX_DEPTH) return;

  const children = (await describe(conn, `${s}.${ident(table)}`)).filter((x) => isStructList(x.type));
  if (children.length === 0) return;
  let key = `${safe(col.name)}_n`;
  while (keys.includes(key)) key += "_";
  const childKeys = [...keys, key];
  for (const cc of children) {
    let child = `${table}_${safe(cc.name)}`;
    while (taken.has(child.toLowerCase())) child += "_";
    taken.add(child.toLowerCase());
    // the child sees this table's `_n` under its key name (parts._n -> parts_n).
    const src = `(SELECT _item, ${keys.map((k) => `${ident(k)}, `).join("")}_n AS ${ident(key)}, ${ident(cc.name)} FROM ${s}.${ident(table)})`;
    await explode(conn, s, src, cc, child, childKeys, taken, depth + 1);
    await conn.run(`ALTER TABLE ${s}.${ident(table)} DROP COLUMN ${ident(cc.name)}`);
  }
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
