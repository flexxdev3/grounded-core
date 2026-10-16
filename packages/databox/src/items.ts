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
  /** sha1 over (relative path, size, mtime) of every item: any add/remove/edit changes it. */
  fingerprint: string;
}

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
  if (!existsSync(dir)) return { itemsDir: dir, kinds, files: 0, bytes, newestMtimeMs: 0, fingerprint: "" };

  const seen = new Map<string, string>();
  const count = (abs: string, rel: string): void => {
    const st = statSync(abs);
    bytes += st.size;
    newest = Math.max(newest, st.mtimeMs);
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
  const fingerprint = lines.length ? createHash("sha1").update(lines.join("\n")).digest("hex") : "";
  return { itemsDir: dir, kinds, files: lines.length, bytes, newestMtimeMs: newest, fingerprint };
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
