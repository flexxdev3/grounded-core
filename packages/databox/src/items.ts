import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DataboxError } from "./types.js";

/**
 * A kind = one family of items = one DuckDB schema.
 *   items/*.json          -> kind "main"  (tables: items, <array keys>)
 *   items/<dir>/**.json   -> kind <dir>   (tables: <dir>.items, <dir>.<array keys>)
 * Folders starting with "." or "_" are skipped (extractor scratch space).
 */
export interface KindScan {
  kind: string;
  /** absolute folder holding this kind's files, forward slashes, trailing slash. */
  prefix: string;
  /** DuckDB glob for read_json. */
  glob: string;
  files: number;
}

export interface ItemsScan {
  itemsDir: string;
  kinds: KindScan[];
  files: number;
  bytes: number;
  newestMtimeMs: number;
  /** sha1 over (relative path, size, mtime) of every item + the type hints: any add/remove/edit changes it. */
  fingerprint: string;
  /** relative path under items/ (forward slashes) -> "size:mtime": what an incremental build diffs. */
  stamps: Record<string, string>;
  /** column type hints from manifest.json (see readTypeHints). */
  hints: TypeHints;
}

/**
 * `manifest.json` -> `"databox": { "types": { "<table>.<column>": "<DuckDB type>" } }`,
 * `<table>` as /schema names it (`cars.parts_meshes_uv`, or `items` for top-level files).
 * The extractor declares what JSON cannot say, e.g. a float32 source value: JSON
 * numbers infer DOUBLE, `"FLOAT[4]"` halves those columns (FH6 catalogue: -50 MB,
 * lossless because the values came from float32). A hint naming no column fails the build.
 */
export type TypeHints = Record<string, string>;

const slash = (p: string) => p.replaceAll("\\", "/");

/** A folder name as a SQL schema name: lowercase, [a-z0-9_], not starting with a digit. */
export function kindName(dir: string): string {
  let k = dir.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (/^[0-9]/.test(k)) k = `k_${k}`;
  return k;
}

export function itemsDir(root: string): string {
  return join(resolve(root), "items");
}

export function scanItems(root: string): ItemsScan {
  const dir = itemsDir(root);
  const lines: string[] = [];
  let bytes = 0;
  let newest = 0;
  const kinds: KindScan[] = [];
  const stamps: Record<string, string> = {};
  const hints = readTypeHints(root);
  if (!existsSync(dir)) return { itemsDir: dir, kinds, files: 0, bytes, newestMtimeMs: 0, fingerprint: "", stamps, hints };

  const seen = new Map<string, string>();
  const count = (abs: string, rel: string): void => {
    const st = statSync(abs);
    bytes += st.size;
    newest = Math.max(newest, st.mtimeMs);
    stamps[rel] = `${st.size}:${Math.trunc(st.mtimeMs)}`;
    lines.push(`${rel}\t${st.size}\t${Math.trunc(st.mtimeMs)}`);
  };
  const walk = (abs: string, rel: string): number => {
    let n = 0;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const a = join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) n += walk(a, r);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
        count(a, r);
        n++;
      }
    }
    return n;
  };

  let rootFiles = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const abs = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
      count(abs, e.name);
      rootFiles++;
    } else if (e.isDirectory()) {
      const kind = kindName(e.name);
      if (kind === "main") throw new DataboxError(`items/${e.name}: "main" is reserved for items directly under items/`, "DATABOX_BUILD", 500);
      const clash = seen.get(kind);
      if (clash) throw new DataboxError(`items/${e.name} and items/${clash} both map to table schema "${kind}"; rename one`, "DATABOX_BUILD", 500);
      seen.set(kind, e.name);
      const n = walk(abs, e.name);
      if (n > 0) kinds.push({ kind, prefix: `${slash(abs)}/`, glob: `${slash(abs)}/**/*.json`, files: n });
    }
  }
  if (rootFiles > 0) kinds.unshift({ kind: "main", prefix: `${slash(dir)}/`, glob: `${slash(dir)}/*.json`, files: rootFiles });

  lines.sort();
  const files = lines.length;
  if (files && Object.keys(hints).length) lines.push(`hints\t${JSON.stringify(hints)}`);
  const fingerprint = files ? createHash("sha1").update(lines.join("\n")).digest("hex") : "";
  return { itemsDir: dir, kinds, files, bytes, newestMtimeMs: newest, fingerprint, stamps, hints };
}

/** The kind (schema) and `_item` of a path relative to items/: `Cars/sub/X.json` -> cars, `sub/X`. */
export function relItem(rel: string): { kind: string; item: string } {
  const i = rel.indexOf("/");
  const kind = i < 0 ? "main" : kindName(rel.slice(0, i));
  return { kind, item: rel.slice(i + 1).replace(/\.json$/i, "") };
}

/** `databox.types` from manifest.json. A missing/unreadable manifest = no hints; a malformed hint throws. */
export function readTypeHints(root: string): TypeHints {
  const p = join(resolve(root), "manifest.json");
  if (!existsSync(p)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
  const types = (raw as { databox?: { types?: unknown } } | null)?.databox?.types;
  if (types === undefined) return {};
  if (typeof types !== "object" || types === null || Array.isArray(types)) {
    throw new DataboxError('manifest.json databox.types must be an object of "<table>.<column>": "<type>"', "DATABOX_BUILD", 500);
  }
  const out: TypeHints = {};
  for (const [k, v] of Object.entries(types)) {
    // the type is spliced into CAST(... AS <type>): type-name characters only.
    if (typeof v !== "string" || !/^[^.]+(\.[^.]+){1,2}$/.test(k) || !/^[A-Za-z0-9_ ,()[\]"]+$/.test(v)) {
      throw new DataboxError(`manifest.json databox.types: "${k}" must be "<table>.<column>": "<DuckDB type>"`, "DATABOX_BUILD", 500);
    }
    out[k] = v;
  }
  return out;
}

/** Top-level scalars of `<root>/manifest.json`, or null. Never throws: a manifest is informational. */
export function readManifest(root: string): Record<string, string | number | boolean> | null {
  const p = join(resolve(root), "manifest.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
