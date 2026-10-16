#!/usr/bin/env node
// Build one release artifact for THIS machine's platform: release/<version>/grounded-<version>-<os>-<arch>.{zip,tar.gz}
// plus a <artifact>.json fragment (sha256, size, node ABI) that scripts/release.mjs folds into manifest.json.
//
//   node scripts/package.mjs [--skip-build]
//
// Native modules are ABI-keyed, so every platform builds its own artifact on its own box
// (Windows on a Windows box, macOS on the mac, Linux on arch1). See RELEASING.md.
//
// Layout (unpacked to $GROUNDED_HOME/lib/<version>/, `current` points at it):
//   bin/grounded, bin/grounded.cmd     shims: node lib/cli.mjs
//   lib/{api,cli,mcp}.mjs              esbuild bundles of the workspace bins
//   lib/node_modules/                  only what cannot be bundled: better-sqlite3 (+bindings), sqlite-vec
//                                      (+ its platform package) and the built console (@grounded/ui)
//   hooks/                             agent session-start hooks (grounded hooks install)
//   release.json                       version, commit, platform, node ABI of this runtime
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = (p) => join(root, "packages", p);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const os = process.platform === "win32" ? "windows" : process.platform; // windows | linux | darwin
const arch = process.arch; // x64 | arm64
const name = `grounded-${version}-${os}-${arch}`;
const outDir = join(root, "release", version);
const stage = join(outDir, name);
const log = (m) => console.log(`[package] ${m}`);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

const commit = git("rev-parse", "HEAD");
if (git("status", "--porcelain", "--untracked-files=no")) {
  console.error("[package] FAIL uncommitted changes - the artifact must match a commit");
  process.exit(2);
}

// 1. build the workspace in dependency order (no pnpm needed on the build box)
if (!process.argv.includes("--skip-build")) {
  for (const p of ["core", "databox", "client", "ui", "api", "mcp", "cli"]) {
    const req = createRequire(join(pkg(p), "package.json"));
    const bin = p === "ui" ? join(dirname(req.resolve("vite/package.json")), "bin", "vite.js") : req.resolve("typescript/bin/tsc");
    log(`build ${p}`);
    execFileSync(process.execPath, p === "ui" ? [bin, "build"] : [bin, "-p", "tsconfig.json"], { cwd: pkg(p), stdio: "inherit" });
  }
}

// 2. bundle the three bins
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "lib", "node_modules"), { recursive: true });
const uiReq = createRequire(join(pkg("ui"), "package.json"));
const esbuild = createRequire(uiReq.resolve("vite/package.json"))("esbuild");
const external = ["better-sqlite3", "sqlite-vec", "onnxruntime-node", "@huggingface/tokenizers", "@duckdb/node-api", "pg-native", "@grounded/ui"];
for (const [bin, entry] of [["api", "api"], ["cli", "cli"], ["mcp", "mcp"]]) {
  await esbuild.build({
    entryPoints: [join(pkg(entry), "dist", "bin.js")],
    outfile: join(stage, "lib", `${bin}.mjs`),
    bundle: true, platform: "node", format: "esm", target: "node20", external, logLevel: "warning",
    // CJS dependencies inside an ESM bundle still call require/__dirname
    banner: { js: "import { createRequire as __gr } from 'node:module'; import { fileURLToPath as __gf } from 'node:url'; import { dirname as __gd } from 'node:path';\nconst require = __gr(import.meta.url); const __filename = __gf(import.meta.url); const __dirname = __gd(__filename);" },
  });
  log(`bundled lib/${bin}.mjs (${(statSync(join(stage, "lib", `${bin}.mjs`)).size / 1024 / 1024).toFixed(1)} MiB)`);
}

// 3. vendor what cannot be bundled
const coreReq = createRequire(join(pkg("core"), "package.json"));
const nm = join(stage, "lib", "node_modules");
const vendor = (from, to, parts) => {
  for (const part of parts) {
    if (!existsSync(join(from, part))) throw new Error(`missing ${join(from, part)}`);
    cpSync(join(from, part), join(nm, to, part), { recursive: true, dereference: true });
  }
};
// package dir via the resolver's search paths: some packages do not export ./package.json,
// and pnpm links them, so return the real path
const dirOf = (req, id) => {
  const hit = req.resolve.paths(id).map((d) => join(d, id)).find((d) => existsSync(join(d, "package.json")));
  if (!hit) throw new Error(`cannot find ${id}`);
  return realpathSync(hit);
};
const bsq = dirOf(coreReq, "better-sqlite3");
vendor(bsq, "better-sqlite3", ["package.json", "lib", "build/Release/better_sqlite3.node"]);
const bsqReq = createRequire(join(bsq, "package.json"));
const bindings = dirOf(bsqReq, "bindings");
vendor(bindings, "bindings", ["package.json", "bindings.js"]);
vendor(dirOf(createRequire(join(bindings, "package.json")), "file-uri-to-path"), "file-uri-to-path", ["package.json", "index.js"]);
const vec = dirOf(coreReq, "sqlite-vec");
vendor(vec, "sqlite-vec", ["package.json", "index.mjs", "index.cjs"]);
const vecPlat = `sqlite-vec-${os}-${arch}`;
const vecPlatDir = dirOf(createRequire(join(vec, "package.json")), vecPlat);
cpSync(vecPlatDir, join(nm, vecPlat), { recursive: true, dereference: true });
vendor(pkg("ui"), "@grounded/ui", ["package.json", "dist"]);

// 4. shims, hooks, identity
mkdirSync(join(stage, "bin"));
writeFileSync(join(stage, "bin", "grounded"), '#!/bin/sh\nDIR="$(cd "$(dirname "$0")/.." && pwd)"\nexec "${NODE:-node}" "$DIR/lib/cli.mjs" "$@"\n', { mode: 0o755 });
writeFileSync(join(stage, "bin", "grounded.cmd"), '@echo off\r\nnode "%~dp0..\lib\cli.mjs" %*\r\n');
cpSync(join(pkg("cli"), "hooks"), join(stage, "hooks"), { recursive: true });
const identity = { version, commit, os, arch, node_abi: process.versions.modules, built_with_node: process.version };
writeFileSync(join(stage, "release.json"), JSON.stringify(identity, null, 2) + "\n");

// 5. smoke the staged runtime before archiving: the bundles must load and the natives must open
const smoke = execFileSync(process.execPath, ["--input-type=module", "-e", `
  const { createRequire } = await import("node:module");
  const req = createRequire(${JSON.stringify(join(stage, "lib", "api.mjs"))});
  const Database = req("better-sqlite3");
  const db = new Database(":memory:");
  req("sqlite-vec").load(db);
  console.log(db.prepare("select vec_version() v").get().v, req.resolve("@grounded/ui/dist/index.html") ? "ui" : "");
`], { encoding: "utf8" }).trim();
const cliVersion = execFileSync(process.execPath, [join(stage, "lib", "cli.mjs"), "--version"], { encoding: "utf8" }).trim();
log(`smoke: sqlite-vec ${smoke}, cli --version ${cliVersion}`);

// 6. archive + fragment
const file = os === "windows" ? `${name}.zip` : `${name}.tar.gz`;
const archive = join(outDir, file);
rmSync(archive, { force: true });
if (os === "windows") execFileSync(join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", archive, "-C", stage, "."]);
else execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
const size = statSync(archive).size;
writeFileSync(`${archive}.json`, JSON.stringify({ name: file, ...identity, sha256, size }, null, 2) + "\n");
log(`OK ${file} ${(size / 1024 / 1024).toFixed(1)} MiB sha256 ${sha256.slice(0, 16)}...`);
log(`next: copy ${file} and ${file}.json to the release box, then scripts/release.mjs`);
