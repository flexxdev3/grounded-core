import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  ".DS_Store",
  "dist",
  "build",
  ".cache",
  ".venv",
  "__pycache__",
];

export interface IgnoreMatcher {
  /** true when a path (relative to root, posix-style) should be ignored. */
  ignores(relPath: string, isDir: boolean): boolean;
}

interface Rule {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

function globToRegex(pattern: string): RegExp {
  // anchor: a leading slash means root-relative; otherwise match any segment.
  let p = pattern;
  const rooted = p.startsWith("/");
  if (rooted) p = p.slice(1);

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
        if (p[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const prefix = rooted ? "^" : "(^|.*/)";
  return new RegExp(`${prefix}${re}(/.*)?$`);
}

export function parseIgnore(lines: string[], includeDefaults = true): IgnoreMatcher {
  const rules: Rule[] = [];
  const all = includeDefaults ? [...DEFAULT_IGNORES, ...lines] : [...lines];
  for (const raw of all) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    rules.push({ negated, dirOnly, regex: globToRegex(line) });
  }
  return {
    ignores(relPath: string, isDir: boolean): boolean {
      let ignored = false;
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(relPath)) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

export function loadIgnore(root: string, ignoreFile: string): IgnoreMatcher {
  const path = join(root, ignoreFile);
  if (!existsSync(path)) return parseIgnore([]);
  try {
    const raw = readFileSync(path, "utf8");
    return parseIgnore(raw.split(/\r?\n/));
  } catch {
    return parseIgnore([]);
  }
}
