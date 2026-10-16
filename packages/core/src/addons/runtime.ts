import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultHome } from "../config.js";
import type { AddonDefinition } from "./catalog.js";

/**
 * Add-on runtimes live outside the Core release: `<home>/addons/<id>/node_modules`.
 * The packaged Core bundles everything pure-JS and vendors only SQLite; native
 * add-on payloads (onnxruntime, DuckDB) are installed on demand with the npm that
 * ships with Node, so a household that never turns an add-on on never downloads it.
 */

export function addonsRoot(home: string): string {
  return join(home, "addons");
}

export function addonRuntimeDir(home: string, id: string): string {
  return join(addonsRoot(home), id);
}

/** Runtime dirs that are complete (staging and parked dirs carry a dot suffix). */
function runtimeDirs(home: string): string[] {
  const root = addonsRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => !d.includes("."))
    .map((d) => join(root, d))
    .filter((d) => existsSync(join(d, "package.json")));
}

/**
 * Import an optional package: the caller's own resolution first (a source checkout
 * has it in node_modules; pass `local` so it resolves from the caller's package,
 * not from core's), then every installed add-on runtime under the service home.
 */
export async function importAddonModule<T = unknown>(
  name: string,
  opts: { home?: string; local?: () => Promise<unknown> } = {},
): Promise<T> {
  const home = opts.home;
  try {
    return (await (opts.local ? opts.local() : import(name))) as T;
  } catch (err) {
    for (const dir of runtimeDirs(home ?? process.env.GROUNDED_HOME ?? defaultHome())) {
      let resolved: string;
      try {
        resolved = createRequire(join(dir, "package.json")).resolve(name);
      } catch {
        continue;
      }
      return (await import(pathToFileURL(resolved).href)) as T;
    }
    throw err;
  }
}

/** The npm CLI that ships beside this Node, or GROUNDED_NPM_CLI. */
export function findNpmCli(execPath: string = process.execPath): string | null {
  const override = process.env.GROUNDED_NPM_CLI;
  if (override) return existsSync(override) ? override : null;
  const bin = dirname(execPath);
  const candidates = [
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"), // Windows installer layout
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // nodejs.org tarballs, Homebrew, nvm
    "/usr/share/nodejs/npm/bin/npm-cli.js", // Debian/Ubuntu packaged npm
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Install (or repair) an add-on's runtime packages into `<home>/addons/<id>/`.
 * Installs into a sibling staging dir and swaps it in, so an interrupted install
 * never leaves a half-written runtime where the loader looks.
 */
export async function installAddonRuntime(
  home: string,
  def: AddonDefinition,
  onProgress?: (detail: string) => void,
): Promise<string> {
  const npm = findNpmCli();
  if (!npm) {
    throw new Error(
      "npm was not found beside Node. Install Node.js from nodejs.org (it includes npm), or set GROUNDED_NPM_CLI to npm-cli.js.",
    );
  }
  const target = addonRuntimeDir(home, def.id);
  const staging = `${target}.installing`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const dependencies = Object.fromEntries(def.runtime.map((p) => [p.name, p.version]));
  writeFileSync(
    join(staging, "package.json"),
    JSON.stringify({ name: `grounded-addon-${def.id}`, private: true, description: `Grounded ${def.name} runtime`, dependencies }, null, 2) + "\n",
  );
  onProgress?.(`downloading ${def.runtime.map((p) => p.name).join(", ")}`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [npm, "install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"],
      { cwd: staging, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const tail = (stderr || err.message).trim().split("\n").slice(-3).join(" ");
        reject(new Error(`installing the ${def.name} runtime failed: ${tail}`));
      },
    );
  });
  // Swap BEFORE loading anything: on Windows a loaded .node locks its folder against rename.
  // A previous (unloaded, incomplete) runtime is parked, then deleted best-effort.
  if (existsSync(target)) {
    const parked = `${target}.old-${Date.now()}`;
    renameSync(target, parked);
    rmSync(parked, { recursive: true, force: true, maxRetries: 2 });
  }
  renameSync(staging, target);
  onProgress?.("verifying");
  for (const p of def.runtime) {
    try {
      const resolved = createRequire(join(target, "package.json")).resolve(p.name);
      await import(pathToFileURL(resolved).href);
    } catch (err) {
      throw new Error(`the ${def.name} runtime installed but ${p.name} does not load here: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return target;
}

/** True when every runtime package loads: from the checkout, or from the add-on dir. */
export async function addonRuntimePresent(home: string, def: AddonDefinition): Promise<boolean> {
  for (const p of def.runtime) {
    try {
      await importAddonModule(p.name, { home });
    } catch {
      return false;
    }
  }
  return true;
}
