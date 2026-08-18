import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadIgnore } from "./groundignore.js";
import type { IgnoreMatcher } from "./groundignore.js";

export interface WalkedFile {
  /** absolute path. */
  absPath: string;
  /** path relative to the walk root, posix-style. */
  relPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

const DEFAULT_EXTS = new Set([".md", ".markdown", ".mdx", ".txt"]);

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function hasIndexableExt(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return DEFAULT_EXTS.has(name.slice(dot).toLowerCase());
}

/**
 * Is this root a directory (or file) the process can actually read? The walker
 * swallows an unreadable root and returns [], which reads downstream as "the
 * tree was empty" — callers must be able to tell the two apart.
 */
export function isReadableDir(root: string): boolean {
  try {
    accessSync(root, constants.R_OK);
    statSync(root);
    return true;
  } catch {
    return false;
  }
}

/** Recursively walk a root, honoring the ignore file and default ignores. */
export function walk(root: string, ignoreFile: string): WalkedFile[] {
  const matcher: IgnoreMatcher = loadIgnore(root, ignoreFile);
  const out: WalkedFile[] = [];

  function recurse(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = toPosix(relative(root, abs));
      if (matcher.ignores(rel, st.isDirectory())) continue;
      if (st.isDirectory()) {
        recurse(abs);
      } else if (st.isFile() && hasIndexableExt(name)) {
        out.push({
          absPath: abs,
          relPath: rel,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        });
      }
    }
  }

  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return out;
  }
  if (rootStat.isFile()) {
    if (hasIndexableExt(root)) {
      out.push({
        absPath: root,
        relPath: toPosix(root),
        mtimeMs: rootStat.mtimeMs,
        sizeBytes: rootStat.size,
      });
    }
    return out;
  }
  recurse(root);
  return out;
}
