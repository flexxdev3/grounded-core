import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireDuck } from "./duck.js";
import { scanItems, type ItemsScan } from "./items.js";
import { applyDelta, diffStamps, NotIncremental, refuseIncremental, type Delta, type GenerationMeta } from "./incremental.js";
import { listTables, materializeKind } from "./plan.js";
import { DataboxError, type ColumnInfo, type IndexPointer, type TableInfo } from "./types.js";

/**
 * The index is DERIVED: `<root>/index/<id>.duckdb`, one file per build
 * ("generation"), and `<root>/index/current.json` naming the live one.
 *
 * Why generations and not one `index.duckdb` swapped in place: on Windows a
 * file another process holds open cannot be renamed over (measured: EPERM),
 * and the MCP server is another process holding the index open. A new
 * generation is written beside the old one, the small pointer is swapped
 * atomically, and readers move over on their next query. Old generations are
 * unlinked best-effort (Windows allows deleting a file open elsewhere; the
 * holder keeps reading until it closes).
 */
export const INDEX_FORMAT = 1;

export function indexDir(root: string): string {
  return join(resolve(root), "index");
}

export function readPointer(root: string): IndexPointer | null {
  const p = join(indexDir(root), "current.json");
  if (!existsSync(p)) return null;
  try {
    const ptr = JSON.parse(readFileSync(p, "utf8")) as IndexPointer;
    if (ptr.format > INDEX_FORMAT) return null;
    if (!existsSync(generationPath(root, ptr.id))) return null;
    return ptr;
  } catch {
    return null;
  }
}

export function generationPath(root: string, id: string): string {
  return join(indexDir(root), `${id}.duckdb`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** rename with retries: a reader may hold current.json open for the microseconds it takes to read it. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await sleep(25);
    }
  }
}

export interface BuildResult {
  pointer: IndexPointer;
  scan: ItemsScan;
}

export function metaPath(root: string, id: string): string {
  return join(indexDir(root), `${id}.meta.json`);
}

function readMeta(root: string, id: string): GenerationMeta | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(root, id), "utf8")) as GenerationMeta;
    return m.format === 1 ? m : null;
  } catch {
    return null;
  }
}

/**
 * Build a new generation from items/ and make it current. Throws DataboxError; the old generation stays live on failure.
 *
 * Incremental unless `full`: only changed items are re-read and spliced into a
 * copy of the live generation (see incremental.ts for when it refuses). Measured
 * on the FH6 catalogue (638 cars, 2489 items, 1.6 GB): full 36 s, one changed
 * car 0.5 s, 64 cars 3.8 s; identical tables either way (15/15 by EXCEPT ALL).
 */
export async function buildIndex(root: string, opts: { scan?: ItemsScan; full?: boolean } = {}): Promise<BuildResult> {
  const duck = await requireDuck();
  const scan = opts.scan ?? scanItems(root);
  if (scan.files === 0) throw new DataboxError(`no items: ${scan.itemsDir} holds no .json file`, "DATABOX_EMPTY", 409);

  const dir = indexDir(root);
  mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${scan.fingerprint.slice(0, 8)}`;
  const file = generationPath(root, id);
  const started = performance.now();

  const prev = readPointer(root);
  const prevMeta = prev ? readMeta(root, prev.id) : null;
  const delta: Delta = prevMeta ? diffStamps(prevMeta, scan) : { changed: [], removed: [] };
  const prevBytes = prev ? statSync(generationPath(root, prev.id), { throwIfNoEntry: false })?.size ?? 0 : 0;
  let note: string | null = opts.full ? "full build requested" : refuseIncremental(prevMeta, prev, scan, delta, prevBytes);

  let instance: Awaited<ReturnType<typeof duck.DuckDBInstance.create>> | undefined;
  const drop = () => {
    try {
      instance?.closeSync();
    } catch {
      /* already failing */
    }
    instance = undefined;
    rmSync(file, { force: true });
    rmSync(`${file}.wal`, { force: true });
  };
  try {
    let kinds: Record<string, ColumnInfo[]> | null = null;
    let tables: TableInfo[] | null = null;

    if (note === null && prev && prevMeta) {
      try {
        copyFileSync(generationPath(root, prev.id), file);
        instance = await duck.DuckDBInstance.create(file);
        const conn = await instance.connect();
        await applyDelta(conn, scan, prevMeta, prev, delta);
        tables = await listTables(conn, true);
        await conn.run("CHECKPOINT");
        conn.closeSync();
        instance.closeSync();
        instance = undefined;
        kinds = prevMeta.kinds;
      } catch (err) {
        if (!(err instanceof NotIncremental)) throw err;
        note = err.message;
        drop();
      }
    }

    if (!kinds) {
      instance = await duck.DuckDBInstance.create(file);
      const conn = await instance.connect();
      const hintsUsed = new Set<string>();
      kinds = {};
      for (const k of scan.kinds) kinds[k.kind] = await materializeKind(conn, k, { hints: scan.hints, hintsUsed });
      const unused = Object.keys(scan.hints).filter((h) => !hintsUsed.has(h));
      if (unused.length) {
        throw new DataboxError(`manifest.json databox.types names no column: ${unused.join(", ")}`, "DATABOX_BUILD", 500);
      }
      tables = await listTables(conn, true);
      await conn.run("CHECKPOINT");
      conn.closeSync();
      instance.closeSync();
      instance = undefined;
    }

    const incremental = note === null;
    const fullBytes = incremental ? prevMeta?.fullBytes : statSync(file).size;
    const meta: GenerationMeta = { format: 1, hints: JSON.stringify(scan.hints), kinds, stamps: scan.stamps, ...(fullBytes ? { fullBytes } : {}) };
    writeFileSync(metaPath(root, id), JSON.stringify(meta), "utf8");
    const pointer: IndexPointer = {
      id,
      builtAt: new Date().toISOString(),
      buildMs: Math.round(performance.now() - started),
      fingerprint: scan.fingerprint,
      files: scan.files,
      bytes: scan.bytes,
      tables: tables ?? [],
      format: INDEX_FORMAT,
      build: incremental
        ? { mode: "incremental", changed: delta.changed.length, removed: delta.removed.length }
        : { mode: "full", reason: note ?? "full build requested" },
    };
    const tmp = join(dir, `current.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(pointer, null, 2), "utf8");
    await renameRetry(tmp, join(dir, "current.json"));
    collectGarbage(root, id);
    return { pointer, scan };
  } catch (err) {
    drop();
    rmSync(metaPath(root, id), { force: true });
    if (err instanceof DataboxError) throw err;
    throw new DataboxError(`index build failed: ${err instanceof Error ? err.message : String(err)}`, "DATABOX_BUILD", 500);
  }
}

/** Remove every generation but `keep`. Best effort: a file still busy is retried on the next build. */
export function collectGarbage(root: string, keep: string): void {
  const dir = indexDir(root);
  for (const name of readdirSync(dir)) {
    if (name.startsWith(`${keep}.`) || name === "current.json") continue;
    if (!/\.(duckdb|duckdb\.wal|tmp|meta\.json)$/.test(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* busy: next build */
    }
  }
}
