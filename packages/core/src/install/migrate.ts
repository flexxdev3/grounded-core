/**
 * Cabinet migration — move a pre-split cabinet out of `~/.grounded/cabinet`
 * into the visible `~/Grounded/Cabinet`.
 *
 * `.grounded` holds configuration, models and dependencies only; the user's
 * data lives in `~/Grounded/Cabinet`. Installs from before that split keep
 * working where they are (`cabinetLayout` never selects a new empty cabinet
 * over one with data), and this is the explicit, operator-run move.
 *
 * Safe by construction:
 *   - refuses unless the source holds files and the target holds none;
 *   - refuses when config.toml pins `storage.path` inside the source (moving
 *     the files would strand the configured database);
 *   - same filesystem: one atomic directory rename, then a size check;
 *   - otherwise: copy, verify every file by size + sha256, and only then
 *     remove the source. A failed verify deletes the copy and leaves the
 *     source untouched.
 * The service must be stopped first (the caller owns that).
 */
import { createHash } from "node:crypto";
import { createReadStream, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { cabinetLayout, hasCabinetData, CONFIG_FILENAME, LEGACY_CABINET_DIRNAME, SYSTEM_DIRNAME } from "../config.js";

export class CabinetMigrationError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_DEFAULT_HOME" | "NOTHING_TO_MIGRATE" | "TARGET_NOT_EMPTY" | "PINNED_STORAGE_PATH" | "VERIFY_FAILED",
  ) {
    super(message);
    this.name = "CabinetMigrationError";
  }
}

export interface CabinetMigrationPlan {
  from: string;
  to: string;
}

export interface CabinetMigrationResult extends CabinetMigrationPlan {
  method: "rename" | "copy";
  files: number;
  bytes: number;
}

interface Entry {
  size: number;
}

function inventory(root: string, rel = "", out = new Map<string, Entry>()): Map<string, Entry> {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) inventory(root, r, out);
    else out.set(r, { size: statSync(join(root, r)).size });
  }
  return out;
}

function sha256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", rej)
      .on("end", () => res(h.digest("hex")));
  });
}

function within(child: string, parent: string): boolean {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r));
}

/** A `storage.path` written in config.toml (not the derived default). */
function pinnedStoragePath(home: string): string | undefined {
  const p = join(home, CONFIG_FILENAME);
  if (!existsSync(p)) return undefined;
  try {
    const t = parseToml(readFileSync(p, "utf8")) as { storage?: { path?: unknown } };
    return typeof t.storage?.path === "string" ? t.storage.path : undefined;
  } catch {
    return undefined;
  }
}

/** What `migrateCabinet` would move, or a CabinetMigrationError saying why not. */
export function planCabinetMigration(home: string): CabinetMigrationPlan {
  const layout = cabinetLayout(home);
  if (layout.kind === "custom" || layout.kind === "core" || !layout.target) {
    throw new CabinetMigrationError(
      `${home} is not a default ${SYSTEM_DIRNAME} home; its cabinet (${layout.dir}) stays where it is.`,
      "NOT_DEFAULT_HOME",
    );
  }
  const from = join(home, LEGACY_CABINET_DIRNAME);
  const to = layout.target;
  if (!hasCabinetData(from)) {
    throw new CabinetMigrationError(`nothing to migrate: ${from} holds no files. The cabinet is ${layout.dir}.`, "NOTHING_TO_MIGRATE");
  }
  if (hasCabinetData(to)) {
    throw new CabinetMigrationError(
      `${to} already holds files, so ${from} cannot be moved into it. Move or merge one of them by hand, then re-run.`,
      "TARGET_NOT_EMPTY",
    );
  }
  const pinned = pinnedStoragePath(home);
  if (pinned && within(pinned, from)) {
    throw new CabinetMigrationError(
      `config.toml pins storage.path = ${pinned}, inside ${from}. Remove that line (the default is ${join(to, "grounded.db")}) and re-run.`,
      "PINNED_STORAGE_PATH",
    );
  }
  return { from, to };
}

/** Move the legacy cabinet into `~/Grounded/Cabinet`. The service must be stopped. */
export async function migrateCabinet(
  home: string,
  opts: { rename?: (from: string, to: string) => void } = {},
): Promise<CabinetMigrationResult> {
  const { from, to } = planCabinetMigration(home);
  const before = inventory(from);
  const bytes = [...before.values()].reduce((n, e) => n + e.size, 0);

  // The target holds no files (checked above) but may hold an empty skeleton
  // (bootstrap's dirs). Clear it so the source can take its place.
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });

  let method: CabinetMigrationResult["method"] = "rename";
  try {
    (opts.rename ?? renameSync)(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
    method = "copy";
  }

  if (method === "rename") {
    const after = inventory(to);
    for (const [rel, e] of before) {
      if (after.get(rel)?.size !== e.size) {
        throw new CabinetMigrationError(`verify failed after rename: ${rel} missing or changed in ${to}`, "VERIFY_FAILED");
      }
    }
    return { from, to, method, files: before.size, bytes };
  }

  cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  try {
    for (const [rel, e] of before) {
      const dst = join(to, rel);
      if (!existsSync(dst) || statSync(dst).size !== e.size) throw new Error(`${rel} missing or wrong size`);
      const [a, b] = await Promise.all([sha256(join(from, rel)), sha256(dst)]);
      if (a !== b) throw new Error(`${rel} checksum mismatch`);
    }
  } catch (err) {
    rmSync(to, { recursive: true, force: true });
    throw new CabinetMigrationError(`verify failed, copy removed, ${from} untouched: ${(err as Error).message}`, "VERIFY_FAILED");
  }
  rmSync(from, { recursive: true, force: true });
  return { from, to, method, files: before.size, bytes };
}
