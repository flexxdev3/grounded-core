import type { DuckDBConnection } from "@duckdb/node-api";
import { ident, lit } from "./duck.js";
import type { KindScan } from "./items.js";
import type { ColumnInfo, TableInfo } from "./types.js";

/**
 * How a kind's JSON files become tables. Shared by the index build (TABLEs)
 * and the no-index fallback (VIEWs over read_json), so the same SQL answers
 * either way.
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
 *  only in item 600 still gets a column instead of failing the build. */
const READ_OPTS = "union_by_name = true, filename = '_databox_file', sample_size = -1, maximum_object_size = 1073741824";
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

/**
 * Materialize one kind: `_raw` from the files, then `items` + one relation per
 * array key. `as` = TABLE for the index (then `_raw` is dropped), VIEW for the
 * fallback (where `_raw` must stay: the views read through it).
 */
export async function materializeKind(conn: DuckDBConnection, k: KindScan, as: "TABLE" | "VIEW"): Promise<void> {
  const s = ident(k.kind);
  if (k.kind !== "main") await conn.run(`CREATE SCHEMA IF NOT EXISTS ${s}`);
  await conn.run(`CREATE ${as} ${s}.${RAW} AS ${readJsonSql(k)}`);
  const cols = await describe(conn, `${s}.${RAW}`);

  const scalar = cols.filter((c) => !c.type.endsWith("[]")).map((c) => ident(c.name));
  await conn.run(`CREATE ${as} ${s}."items" AS SELECT ${scalar.join(", ")} FROM ${s}.${RAW}`);

  for (const c of cols) {
    if (!c.type.endsWith("[]")) continue;
    const col = ident(c.name);
    const element = c.type.slice(0, -2);
    // two unnests in one SELECT zip together: position + element.
    const inner = `SELECT _item, unnest(generate_series(1, len(${col}))) AS _n, unnest(${col}) AS _el FROM ${s}.${RAW}`;
    const body = element.startsWith("STRUCT(")
      ? `SELECT _item, _n, _el.* FROM (${inner})`
      : `SELECT _item, _n, _el AS value FROM (${inner})`;
    await conn.run(`CREATE ${as} ${s}.${ident(arrayTableName(c.name))} AS ${body}`);
  }
  if (as === "TABLE") await conn.run(`DROP TABLE ${s}.${RAW}`);
}

/** Every user-facing table/view with its columns and row count, internal `_raw` excluded. */
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
