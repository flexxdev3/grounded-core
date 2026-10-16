import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, indexDir, readPointer } from "./build.js";
import { duckHealth } from "./duck.js";
import { readManifest, scanItems, type ItemsScan } from "./items.js";
import { openIndexHandle, openJsonHandle, retire, runQuery, type Handle } from "./query.js";
import {
  BOX_NAME,
  DataboxError,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_MAX_MS,
  type BoxConfig,
  type BoxSchema,
  type BoxStatus,
  type IndexPointer,
  type QueryOptions,
  type QueryResult,
} from "./types.js";

export interface DataboxOptions {
  boxes: BoxConfig[];
  /**
   * true in the API process: builds indexes and refreshes a stale box in the
   * background. false everywhere else (MCP, CLI): DuckDB allows ONE writer, so
   * readers only ever open the current generation read-only.
   */
  writer: boolean;
  /** after every successful build, and at start() for a box already fresh (the API ingests the schema card). */
  onIndexed?: (box: BoxConfig, schema: BoxSchema, pointer: IndexPointer) => Promise<void> | void;
  log?: (msg: string) => void;
}

interface BoxRuntime {
  cfg: BoxConfig;
  handle: Handle | null;
  opening: Promise<Handle> | null;
  building: Promise<IndexPointer> | null;
  /** fingerprint whose build failed: no automatic retry until the items change. */
  failedFingerprint: string | null;
  scan: { at: number; scan: ItemsScan } | null;
}

/** How long one items/ scan answers staleness checks. A scan is a stat walk (ms for ~1k files). */
const SCAN_TTL_MS = 2000;

/** Validate `[[databox.box]]` entries: lowercase names, unique, a root each. */
export function validateBoxes(raw: unknown): BoxConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new DataboxError("[[databox.box]] must be an array of tables", "DATABOX_CONFIG", 500);
  const seen = new Set<string>();
  return raw.map((b: unknown, i) => {
    const r = (b ?? {}) as Record<string, unknown>;
    const name = r["name"];
    const root = r["root"];
    if (typeof name !== "string" || !BOX_NAME.test(name)) {
      throw new DataboxError(`databox.box[${i}].name must match ${BOX_NAME} (got ${JSON.stringify(name)})`, "DATABOX_CONFIG", 500);
    }
    if (typeof root !== "string" || !root) throw new DataboxError(`databox.box "${name}" needs a root folder`, "DATABOX_CONFIG", 500);
    if (seen.has(name)) throw new DataboxError(`databox.box "${name}" is declared twice`, "DATABOX_CONFIG", 500);
    seen.add(name);
    const description = typeof r["description"] === "string" ? (r["description"] as string) : undefined;
    return { name, root, ...(description ? { description } : {}) };
  });
}

export class Databox {
  private readonly rt = new Map<string, BoxRuntime>();

  constructor(private readonly opts: DataboxOptions) {
    for (const cfg of validateBoxes(opts.boxes)) {
      this.rt.set(cfg.name, { cfg, handle: null, opening: null, building: null, failedFingerprint: null, scan: null });
    }
  }

  boxes(): BoxConfig[] {
    return [...this.rt.values()].map((b) => b.cfg);
  }

  async health(): Promise<{ ok: boolean; detail: string; boxes: number }> {
    const h = await duckHealth();
    return { ...h, boxes: this.rt.size };
  }

  /** Writer only: build what is missing or stale, and announce what is already fresh. Never throws. */
  start(): void {
    if (!this.opts.writer) return;
    for (const b of this.rt.values()) {
      void (async () => {
        const scan = this.scan(b, true);
        if (scan.files === 0) return;
        const ptr = readPointer(b.cfg.root);
        if (ptr && ptr.fingerprint === scan.fingerprint) await this.announce(b, ptr);
        else await this.kick(b, false);
      })().catch((err: unknown) => this.log(`databox ${b.cfg.name}: ${errMsg(err)}`));
    }
  }

  async list(): Promise<BoxStatus[]> {
    return Promise.all([...this.rt.values()].map((b) => this.statusOf(b)));
  }

  async status(name: string): Promise<BoxStatus> {
    return this.statusOf(this.box(name));
  }

  async schema(name: string): Promise<BoxSchema> {
    const b = this.box(name);
    const h = await this.handle(b);
    const ptr = h.source === "index" ? readPointer(b.cfg.root) : null;
    const stale = this.isStale(b, ptr);
    return {
      box: b.cfg.name,
      ...(b.cfg.description ? { description: b.cfg.description } : {}),
      source: h.source,
      stale,
      indexedAt: ptr?.builtAt ?? null,
      tables: h.tables,
      manifest: readManifest(b.cfg.root),
    };
  }

  async query(name: string, sql: unknown, opts: QueryOptions = {}): Promise<QueryResult> {
    const b = this.box(name);
    if (typeof sql !== "string" || !sql.trim()) throw new DataboxError('"sql" must be a non-empty string', "DATABOX_SQL", 400);
    const limit = opts.limit ?? LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
      throw new DataboxError(`"limit" must be an integer in 1..${LIMIT_MAX}`, "DATABOX_SQL", 400);
    }
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_DEFAULT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MAX_MS) {
      throw new DataboxError(`"timeoutMs" must be an integer in 1..${TIMEOUT_MAX_MS}`, "DATABOX_SQL", 400);
    }
    const started = performance.now();
    const h = await this.handle(b);
    const ptr = h.source === "index" ? readPointer(b.cfg.root) : null;
    const stale = this.isStale(b, ptr);
    const run = await runQuery(h, sql.trim(), limit, timeoutMs);
    return {
      data: run.rows,
      meta: {
        returned: run.rows.length,
        available: run.available,
        availableIsFloor: run.availableIsFloor,
        truncated: run.rows.length < run.available,
        columns: run.columns,
        box: b.cfg.name,
        source: h.source,
        stale,
        indexedAt: ptr?.builtAt ?? null,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
        citation: `databox:${b.cfg.name}`,
        sql: sql.trim(),
      },
    };
  }

  /**
   * Writer only: (re)build the index. Resolves when the build finishes.
   * Unchanged items are a no-op unless `force`. Changed items rebuild incrementally;
   * `force` = full build (also drops columns only removed items used).
   */
  async index(name: string, opts: { force?: boolean } = {}): Promise<IndexPointer> {
    const b = this.box(name);
    if (!this.opts.writer) throw new DataboxError("this process only reads; the Grounded service builds indexes", "DATABOX_READ_ONLY", 409);
    return this.kick(b, opts.force ?? false);
  }

  async close(): Promise<void> {
    for (const b of this.rt.values()) {
      if (b.handle) retire(b.handle);
      b.handle = null;
    }
  }

  // ---- internals -------------------------------------------------------

  private box(name: string): BoxRuntime {
    const b = this.rt.get(name);
    if (!b) {
      const known = [...this.rt.keys()];
      throw new DataboxError(
        `no box "${name}"${known.length ? ` (boxes: ${known.join(", ")})` : " (no box is configured)"}`,
        "DATABOX_NOT_FOUND",
        404,
      );
    }
    return b;
  }

  private scan(b: BoxRuntime, fresh = false): ItemsScan {
    if (!fresh && b.scan && Date.now() - b.scan.at < SCAN_TTL_MS) return b.scan.scan;
    const scan = scanItems(b.cfg.root);
    b.scan = { at: Date.now(), scan };
    return scan;
  }

  /** Stale = items changed after the live generation was built. A writer starts the rebuild. */
  private isStale(b: BoxRuntime, ptr: IndexPointer | null): boolean {
    const scan = this.scan(b);
    const stale = ptr !== null && ptr.fingerprint !== scan.fingerprint;
    if (this.opts.writer && scan.files > 0 && (stale || ptr === null) && !b.building && b.failedFingerprint !== scan.fingerprint) {
      void this.kick(b, false).catch(() => {
        /* recorded in lastError */
      });
    }
    return stale;
  }

  /** The handle for the live generation, or the JSON fallback when there is none. */
  private async handle(b: BoxRuntime): Promise<Handle> {
    const ptr = readPointer(b.cfg.root);
    let key: string;
    let open: () => Promise<Handle>;
    if (ptr) {
      key = `index:${ptr.id}`;
      open = () => openIndexHandle(b.cfg.root, ptr.id, ptr.tables);
    } else {
      const scan = this.scan(b);
      if (scan.files === 0) {
        throw new DataboxError(`box "${b.cfg.name}" has no items yet: an extractor writes ${scan.itemsDir}/**.json`, "DATABOX_EMPTY", 409);
      }
      key = `json:${scan.fingerprint}`;
      open = () => openJsonHandle(scan);
    }
    if (b.handle?.key === key) return b.handle;
    if (b.opening) {
      const h = await b.opening;
      if (h.key === key) return h;
    }
    b.opening = open();
    try {
      const h = await b.opening;
      if (b.handle) retire(b.handle);
      b.handle = h;
      return h;
    } finally {
      b.opening = null;
    }
  }

  private kick(b: BoxRuntime, force: boolean): Promise<IndexPointer> {
    if (b.building) return b.building;
    b.building = (async () => {
      const scan = this.scan(b, true);
      const current = readPointer(b.cfg.root);
      if (!force && current && current.fingerprint === scan.fingerprint) return current;
      const { pointer } = await buildIndex(b.cfg.root, { scan, full: force });
      b.failedFingerprint = null;
      rmSync(join(indexDir(b.cfg.root), "last-error.json"), { force: true });
      const how = pointer.build?.mode === "incremental" ? `incremental, ${pointer.build.changed} changed + ${pointer.build.removed} removed` : `full: ${pointer.build?.reason ?? ""}`;
      this.log(`databox ${b.cfg.name}: indexed ${pointer.files} items in ${pointer.buildMs} ms (${pointer.tables.length} tables, ${how})`);
      await this.announce(b, pointer);
      return pointer;
    })()
      .catch((err: unknown) => {
        b.failedFingerprint = b.scan?.scan.fingerprint ?? null;
        const lastError = { at: new Date().toISOString(), message: errMsg(err) };
        try {
          writeFileSync(join(indexDir(b.cfg.root), "last-error.json"), JSON.stringify(lastError, null, 2), "utf8");
        } catch {
          /* the box folder may not exist at all */
        }
        this.log(`databox ${b.cfg.name}: index build failed: ${lastError.message}`);
        throw err;
      })
      .finally(() => {
        b.building = null;
      });
    return b.building;
  }

  private async announce(b: BoxRuntime, pointer: IndexPointer): Promise<void> {
    if (!this.opts.onIndexed) return;
    try {
      await this.opts.onIndexed(b.cfg, {
        box: b.cfg.name,
        ...(b.cfg.description ? { description: b.cfg.description } : {}),
        source: "index",
        stale: false,
        indexedAt: pointer.builtAt,
        tables: pointer.tables,
        manifest: readManifest(b.cfg.root),
      }, pointer);
    } catch (err) {
      this.log(`databox ${b.cfg.name}: schema card not delivered: ${errMsg(err)}`);
    }
  }

  private async statusOf(b: BoxRuntime): Promise<BoxStatus> {
    const scan = this.scan(b);
    const ptr = readPointer(b.cfg.root);
    const stale = this.isStale(b, ptr);
    const lastError = readLastError(b.cfg.root);
    const state: BoxStatus["state"] =
      scan.files === 0 ? "empty" : ptr ? (stale ? "stale" : "fresh") : lastError ? "error" : "unindexed";
    return {
      name: b.cfg.name,
      root: b.cfg.root,
      ...(b.cfg.description ? { description: b.cfg.description } : {}),
      state,
      building: b.building !== null,
      items: { files: scan.files, bytes: scan.bytes, newestAt: scan.newestMtimeMs ? new Date(scan.newestMtimeMs).toISOString() : null },
      index: ptr
        ? {
            id: ptr.id,
            builtAt: ptr.builtAt,
            buildMs: ptr.buildMs,
            fingerprint: ptr.fingerprint,
            files: ptr.files,
            bytes: ptr.bytes,
            tables: ptr.tables.length,
            rows: ptr.tables.reduce((n, t) => n + t.rows, 0),
            ...(ptr.build ? { build: ptr.build } : {}),
          }
        : null,
      lastError,
      manifest: readManifest(b.cfg.root),
    };
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.warn(m)))(msg);
  }
}

function readLastError(root: string): { at: string; message: string } | null {
  const p = join(indexDir(root), "last-error.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as { at: string; message: string };
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
