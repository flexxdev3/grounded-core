/**
 * Cabinet bootstrap — the one place that materializes `~/.grounded`.
 *
 * Creates the cabinet dir tree, writes a default `config.toml` (never clobbers
 * an existing one), and runs migrations. Lifted out of the old `ground init`
 * command so every surface shares it: the installer (systemd path), the Docker
 * first-boot entrypoint, and a systemd `ExecStartPre`. Config *resolution* lives
 * in `../config.ts`; this module is the *materialization* side.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { cabinetDir, defaultConfig, defaultHome, loadConfig, visibleRoot, CONFIG_FILENAME } from "../config.js";
import { decorateWindowsFolder } from "./windows.js";
import { openStore } from "../store.js";
import type { GroundedConfig } from "../contract.js";

/** Cabinet sub-directories created under `<home>/cabinet`. */
export const CABINET_DIRS = ["facts", "sessions", "docs", "briefs", "exports", "backups"] as const;

export interface BootstrapOptions {
  /** Cabinet root. Falls back to GROUNDED_HOME, then defaultHome(). */
  home?: string;
  /** Run migrations after writing config (opens + closes a store). Default true. */
  migrate?: boolean;
  /**
   * Is the default embedder reachable? Asked only when a FRESH config is about
   * to be written. Injectable for tests; defaults to a short HTTP probe.
   */
  probeEmbedder?: (baseUrl: string) => Promise<boolean>;
}

export interface BootstrapResult {
  home: string;
  configPath: string;
  /** true if this call wrote config.toml; false if it already existed. */
  wroteConfig: boolean;
  /** true if migrations ran (opened the store). */
  migrated: boolean;
  /**
   * Set when this call wrote config.toml: the embeddings provider it chose and
   * why. `none` means the default ollama did not answer, so the cabinet starts
   * lexical-only instead of failing every write with EMBED_ERROR.
   */
  embeddings?: { provider: string; reason: string };
}

/** GET <ollama>/api/tags with a short timeout — true when ollama answers. */
export async function probeOllama(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the cabinet root the same way the rest of the engine does. */
export function resolveHome(home?: string): string {
  return home ?? process.env.GROUNDED_HOME ?? defaultHome();
}

/** Serialize a config to the TOML we write on first init. */
export function renderConfigToml(cfg: GroundedConfig): string {
  const e = cfg.embeddings;
  const r = cfg.recall;
  const i = cfg.ingest;
  const s = cfg.storage;

  // Keep the file *portable*: never persist environment-dependent absolute paths.
  // `home` is always resolved at load (GROUNDED_HOME / default), and the default
  // sqlite path derives from it — so writing them would pin a cabinet to one
  // location and break relocating it (e.g. a Docker install writing the host
  // file with the container-only `/cabinet` path). Only persist a sqlite `path`
  // when the operator set a *custom* one; postgres url/schema are always kept.
  const defaultSqlitePath = join(cabinetDir(cfg.home), "grounded.db");
  const customPath =
    s.path !== undefined && s.path !== defaultSqlitePath ? s.path : undefined;

  const lines = [
    `[storage]`,
    `adapter = ${JSON.stringify(s.adapter)}`,
    customPath !== undefined ? `path = ${JSON.stringify(customPath)}` : null,
    s.url !== undefined ? `url = ${JSON.stringify(s.url)}` : null,
    s.schema !== undefined ? `schema = ${JSON.stringify(s.schema)}` : null,
    ``,
    `[embeddings]`,
    `provider = ${JSON.stringify(e.provider)}`,
    e.baseUrl !== undefined ? `baseUrl = ${JSON.stringify(e.baseUrl)}` : null,
    e.model !== undefined ? `model = ${JSON.stringify(e.model)}` : null,
    e.dims !== undefined ? `dims = ${e.dims}` : null,
    ``,
    `[recall]`,
    `rrfK = ${r.rrfK}`,
    ``,
    `[recall.sourceCaps]`,
    `fact = ${r.sourceCaps.fact}`,
    `session = ${r.sourceCaps.session}`,
    `doc = ${r.sourceCaps.doc}`,
    ``,
    `[recall.boosts]`,
    `pinned = ${r.boosts.pinned}`,
    `importance = ${r.boosts.importance}`,
    `recencyHalfLifeDays = ${r.boosts.recencyHalfLifeDays}`,
    `activeStatus = ${r.boosts.activeStatus}`,
    ``,
    `[ingest]`,
    `ignoreFile = ${JSON.stringify(i.ignoreFile)}`,
    `stripPrivate = ${i.stripPrivate}`,
    `chunkChars = ${i.chunkChars}`,
    `chunkOverlap = ${i.chunkOverlap}`,
    ``,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

/**
 * Create/repair the cabinet and (by default) run migrations. Idempotent:
 * re-running never clobbers an existing config.toml and only creates missing
 * directories.
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const home = resolveHome(opts.home);
  const base = defaultConfig(home);

  mkdirSync(base.home, { recursive: true });
  for (const dir of CABINET_DIRS) {
    mkdirSync(join(cabinetDir(base.home), dir), { recursive: true });
  }
  mkdirSync(join(base.home, "logs"), { recursive: true });
  mkdirSync(join(base.home, "mcp"), { recursive: true });
  // The default Windows folder sits beside Documents and Downloads, so it gets
  // the Grounded icon like they get theirs, and its `.core` is hidden. A folder
  // the operator chose (--home / GROUNDED_HOME) is theirs: never decorated.
  if (process.platform === "win32" && base.home === defaultHome()) {
    await decorateWindowsFolder(visibleRoot(base.home), base.home);
  }

  const configPath = join(base.home, CONFIG_FILENAME);
  let wroteConfig = false;
  let embeddings: BootstrapResult["embeddings"];
  if (!existsSync(configPath)) {
    // The default embedder is ollama on localhost. A fresh cabinet on a box
    // without it would fail every write with EMBED_ERROR, which breaks
    // "useful without an LLM". So ask once, here, and start lexical-only when
    // nothing answers. Never applied to an existing config.toml.
    const cfg = base;
    if (cfg.embeddings.provider === "ollama") {
      const url = cfg.embeddings.baseUrl ?? "http://localhost:11434";
      const probe = opts.probeEmbedder ?? probeOllama;
      if (await probe(url)) {
        embeddings = { provider: "ollama", reason: `ollama answered at ${url}` };
      } else {
        cfg.embeddings = { provider: "none" };
        embeddings = {
          provider: "none",
          reason: `no ollama at ${url}: lexical-only recall. Install ollama and set [embeddings] provider = "ollama" to add vectors.`,
        };
      }
    }
    writeFileSync(configPath, renderConfigToml(cfg), "utf8");
    wroteConfig = true;
  }

  let migrated = false;
  if (opts.migrate !== false) {
    const config = loadConfig({ home });
    const store = await openStore(config);
    try {
      await store.init();
      migrated = true;
    } finally {
      await store.close().catch(() => {});
    }
  }

  return { home: base.home, configPath, wroteConfig, migrated, embeddings };
}
