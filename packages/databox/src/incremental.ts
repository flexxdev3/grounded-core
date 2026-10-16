import type { DuckDBConnection } from "@duckdb/node-api";
import { ident, lit, slash } from "./duck.js";
import { relItem, type ItemsScan } from "./items.js";
import { describe, materializeKind } from "./plan.js";
import type { ColumnInfo, IndexPointer } from "./types.js";

/**
 * Incremental build: copy the live generation, delete the rows of every
 * changed or removed item, re-read ONLY the changed files and insert their
 * rows. Changed files are read with the previous build's exact raw schema, so
 * their tables come out column-for-column like the index's.
 *
 * Refused (the caller runs a full build) when the result could differ from a
 * full build's: a changed item brings a key or a wider type the stored schema
 * does not have, a kind appears or disappears, the type hints changed, or so
 * many items changed that a full build is faster anyway.
 *
 * One known difference, on purpose: a column only REMOVED items used stays
 * (all NULL) until the next full build (`force`).
 */

/** `<id>.meta.json` beside each generation: what the next incremental build needs. */
export interface GenerationMeta {
  format: 1;
  /** JSON of the type hints the generation was built with. */
  hints: string;
  /** raw schema per kind (read_json columns, without `_item`). */
  kinds: Record<string, ColumnInfo[]>;
  /** items/ relative path -> "size:mtime" at build time. */
  stamps: Record<string, string>;
  /** file size right after the last FULL build; incremental builds carry it forward. */
  fullBytes?: number;
}

/** Above this share of changed + removed items a full build is used. Measured on the FH6
 *  catalogue: 1 car 0.5 s, 8 cars 1.4 s, 64 cars 3.8 s, 300 cars 15.9 s; full 36 s. */
export const INCREMENTAL_MAX_SHARE = 0.25;
/** Incremental builds append; past this growth over the last full build, the next build is full (compacts).
 *  Measured: +7% after 373 of 638 cars were rewritten in four incremental builds. */
export const INCREMENTAL_MAX_GROWTH = 1.25;

export interface Delta {
  changed: string[];
  removed: string[];
}

export function diffStamps(meta: GenerationMeta, scan: ItemsScan): Delta {
  const changed = Object.keys(scan.stamps).filter((rel) => meta.stamps[rel] !== scan.stamps[rel]);
  const removed = Object.keys(meta.stamps).filter((rel) => !(rel in scan.stamps));
  return { changed, removed };
}

/** Why an incremental build cannot be used, or null when it can. */
export function refuseIncremental(
  meta: GenerationMeta | null,
  prev: IndexPointer | null,
  scan: ItemsScan,
  d: Delta,
  prevBytes: number,
): string | null {
  if (!prev || !meta) return "no previous generation to update";
  if (meta.fullBytes && prevBytes > INCREMENTAL_MAX_GROWTH * meta.fullBytes) {
    return `index grew ${Math.round((prevBytes / meta.fullBytes - 1) * 100)}% since the last full build: compacting`;
  }
  if (meta.hints !== JSON.stringify(scan.hints)) return "type hints changed";
  const before = Object.keys(meta.kinds).sort().join(",");
  const now = scan.kinds.map((k) => k.kind).sort().join(",");
  if (before !== now) return `kinds changed (${before || "none"} -> ${now || "none"})`;
  const n = d.changed.length + d.removed.length;
  if (n > INCREMENTAL_MAX_SHARE * Math.max(scan.files, Object.keys(meta.stamps).length)) {
    return `${n} of ${scan.files} items changed: a full build is faster`;
  }
  return null;
}

/** Thrown inside applyDelta when the delta does not fit: the caller falls back to a full build. */
export class NotIncremental extends Error {}

/**
 * Apply the delta to `conn` (an open copy of the previous generation).
 * Returns nothing; throws NotIncremental when the changed items do not fit the stored schema.
 */
export async function applyDelta(conn: DuckDBConnection, scan: ItemsScan, meta: GenerationMeta, prev: IndexPointer, d: Delta): Promise<void> {
  const base = slash(scan.itemsDir);
  for (const k of scan.kinds) {
    const changed = d.changed.filter((rel) => relItem(rel).kind === k.kind);
    const gone = [...changed, ...d.removed.filter((rel) => relItem(rel).kind === k.kind)];
    if (gone.length === 0) continue;
    const stored = meta.kinds[k.kind] ?? [];
    const files = changed.map((rel) => `${base}/${rel}`);

    if (files.length) {
      const inferred = await describe(
        conn,
        `SELECT * FROM read_json([${files.map(lit).join(", ")}], union_by_name = true, sample_size = -1)`,
      );
      for (const c of inferred) {
        const s = stored.find((x) => x.name === c.name);
        if (!s) throw new NotIncremental(`changed items add key "${c.name}" to ${k.kind}`);
        if (!typeFits(parseType(c.type), parseType(s.type))) {
          throw new NotIncremental(`${k.kind}.${c.name}: changed items need ${c.type}, the index has ${s.type}`);
        }
      }
    }

    const schema = ident(k.kind);
    const tables = prev.tables.filter((t) => t.kind === k.kind);
    const names = gone.map((rel) => lit(relItem(rel).item)).join(", ");
    for (const t of tables) await conn.run(`DELETE FROM ${schema}.${ident(t.table)} WHERE _item IN (${names})`);

    if (files.length) {
      await conn.run("ATTACH ':memory:' AS _databox_delta");
      try {
        await materializeKind(conn, k, { catalog: "_databox_delta", files, columns: stored, hints: scan.hints });
        const made = await conn.runAndReadAll(
          `SELECT table_name FROM information_schema.tables WHERE table_catalog = '_databox_delta' AND table_schema = ${lit(k.kind)}`,
        );
        for (const row of made.getRowObjectsJson()) {
          const table = String(row["table_name"]);
          if (!tables.some((t) => t.table === table)) throw new NotIncremental(`changed items create table ${k.kind}.${table}`);
          await conn.run(`INSERT INTO ${schema}.${ident(table)} BY NAME SELECT * FROM _databox_delta.${schema}.${ident(table)}`);
        }
      } finally {
        await conn.run("DETACH _databox_delta");
      }
    }
  }
}

// ---- type fit -------------------------------------------------------------

export type DuckType =
  | { t: "scalar"; name: string }
  | { t: "list"; of: DuckType }
  | { t: "struct"; fields: Map<string, DuckType> };

/** Parse a DuckDB type as DESCRIBE prints it: `STRUCT(a BIGINT, "where" VARCHAR)[]`, `FLOAT[4]`. Lists and fixed arrays are both "list". */
export function parseType(s: string): DuckType {
  s = s.trim();
  const arr = /\[\d*\]$/.exec(s);
  if (arr) return { t: "list", of: parseType(s.slice(0, arr.index)) };
  if (s.startsWith("STRUCT(") && s.endsWith(")")) {
    const fields = new Map<string, DuckType>();
    for (const part of splitTop(s.slice(7, -1))) {
      const f = part.trim();
      let name: string;
      let rest: string;
      if (f.startsWith('"')) {
        let i = 1;
        name = "";
        for (; i < f.length; i++) {
          if (f[i] === '"' && f[i + 1] === '"') {
            name += '"';
            i++;
          } else if (f[i] === '"') break;
          else name += f[i];
        }
        rest = f.slice(i + 1);
      } else {
        const sp = f.indexOf(" ");
        name = f.slice(0, sp);
        rest = f.slice(sp + 1);
      }
      fields.set(name, parseType(rest));
    }
    return { t: "struct", fields };
  }
  return { t: "scalar", name: s.toUpperCase() };
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Numeric types read_json infers, narrowest first: a value fits any wider one. */
const NUMERIC = ["UBIGINT", "BIGINT", "HUGEINT", "DOUBLE"];
const unknown = (x: DuckType) => x.t === "scalar" && (x.name === "JSON" || x.name === "NULL");

/**
 * Can a value inferred as `d` (from the changed items) be read as `s` (the
 * index's type) with the same result a full build would give?
 */
export function typeFits(d: DuckType, s: DuckType): boolean {
  if (d.t === "scalar" && d.name === "NULL") return true;
  if (s.t === "scalar" && s.name === "JSON") return true; // the index already mixes types here
  if (d.t === "list" && s.t === "list") {
    if (unknown(d.of)) return true; // only empty arrays in the changed items
    if (unknown(s.of)) return d.of.t === "scalar"; // the index never saw elements: objects would make a new table
    return typeFits(d.of, s.of);
  }
  if (d.t === "struct" && s.t === "struct") {
    for (const [name, ft] of d.fields) {
      const st = s.fields.get(name);
      if (!st || !typeFits(ft, st)) return false;
    }
    return true;
  }
  if (d.t === "scalar" && s.t === "scalar") {
    if (d.name === s.name) return true;
    if (s.name === "VARCHAR") return d.name !== "JSON";
    const di = NUMERIC.indexOf(d.name);
    const si = NUMERIC.indexOf(s.name);
    if (di >= 0 && si >= 0) return d.name === "UBIGINT" ? si >= 2 : di <= si;
    return false;
  }
  return false;
}
