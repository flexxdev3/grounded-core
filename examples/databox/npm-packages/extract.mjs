#!/usr/bin/env node
// Example Databox extractor: catalogue every npm package installed under a folder.
//
//   node extract.mjs <node_modules folder> <box folder>
//
// Writes <box>/items/packages/<name>.json (one item per package@version) and
// <box>/manifest.json. A Databox extractor is just this: decode your source,
// write one JSON object per item. Arrays of objects become tables
// (packages.dependencies, packages.files), scalars land in packages.items.
// Re-running is incremental: an unchanged package rewrites nothing, so its
// mtime (and the box's index) stays put.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [src, box] = process.argv.slice(2).map((p) => p && resolve(p));
if (!src || !box) {
  console.error("usage: node extract.mjs <node_modules folder> <box folder>");
  process.exit(2);
}
const out = join(box, "items", "packages");
mkdirSync(out, { recursive: true });

const seen = new Set();
let written = 0;

/** Walk node_modules, including scoped (@org/x) and nested/.pnpm layouts. */
function walk(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.name.startsWith("@") || e.name === ".pnpm" || e.name === "node_modules") walk(p, depth + 1);
    else if (existsSync(join(p, "package.json"))) {
      take(p);
      walk(join(p, "node_modules"), depth + 1);
    } else if (depth > 0) walk(p, depth + 1);
  }
}

function take(dir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return;
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return;
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) return;
  seen.add(id);

  const deps = (kind, o) => Object.entries(o ?? {}).map(([name, range]) => ({ name, range: String(range), kind }));
  const item = {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === "string" ? pkg.license : null,
    type: pkg.type === "module" ? "module" : "commonjs",
    description: typeof pkg.description === "string" ? pkg.description.slice(0, 300) : null,
    has_types: Boolean(pkg.types || pkg.typings),
    has_install_script: Boolean(pkg.scripts && (pkg.scripts.install || pkg.scripts.postinstall)),
    engines_node: pkg.engines?.node ?? null,
    dependencies: [
      ...deps("prod", pkg.dependencies),
      ...deps("optional", pkg.optionalDependencies),
      ...deps("peer", pkg.peerDependencies),
    ],
    files: readdirSync(dir)
      .filter((f) => !f.startsWith(".") && f !== "node_modules")
      .map((f) => {
        const st = statSync(join(dir, f));
        return { path: f, dir: st.isDirectory(), bytes: st.isDirectory() ? null : st.size };
      }),
  };
  const file = join(out, `${id.replace(/[\\/:*?"<>|]/g, "_")}.json`);
  const body = JSON.stringify(item);
  if (existsSync(file) && readFileSync(file, "utf8") === body) return;
  writeFileSync(file, body);
  written++;
}

walk(src);
// drop items whose package is gone
let removed = 0;
for (const f of readdirSync(out)) {
  const keep = [...seen].some((id) => `${id.replace(/[\\/:*?"<>|]/g, "_")}.json` === f);
  if (!keep) {
    rmSync(join(out, f));
    removed++;
  }
}
writeFileSync(
  join(box, "manifest.json"),
  JSON.stringify({ extractor: "npm-packages example 1", source: src, packages: seen.size }, null, 2),
);
console.log(`${seen.size} packages · ${written} written · ${removed} removed -> ${out}`);
