#!/usr/bin/env node
// Publish release/<version>/ as GitHub release v<version>. Run on the release box (arch1: gh is authenticated there)
// after every platform's scripts/package.mjs output (archive + .json fragment) has been copied into release/<version>/.
//
//   node scripts/release.mjs --notes "what changed" [--dry-run]
//
// Writes manifest.json (the update channel Companion and `grounded update` read) and SHA256SUMS, tags HEAD,
// pushes the tag, and creates the release with every archive + manifest.json + SHA256SUMS attached.
// Releases, not commits, are the update channel; every archive must have been built from the commit being tagged.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "flexxdev3/grounded-core";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const dry = process.argv.includes("--dry-run");
const notes = arg("--notes");
const fail = (m) => { console.error(`[release] FAIL ${m}`); process.exit(2); };
const run = (cmd, a) => execFileSync(cmd, a, { cwd: root, encoding: "utf8" }).trim();
if (!notes) fail('--notes "what changed" is required');

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tag = `v${version}`;
const dir = join(root, "release", version);
const commit = run("git", ["rev-parse", "HEAD"]);
if (run("git", ["status", "--porcelain", "--untracked-files=no"])) fail("uncommitted changes");
if (run("git", ["tag", "-l", tag])) fail(`${tag} already exists - bump the version first (all package.json files in lockstep)`);

const assets = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json")) {
  const a = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (a.version !== version) fail(`${a.name} is version ${a.version}, expected ${version}`);
  if (a.commit !== commit) fail(`${a.name} was built from ${a.commit.slice(0, 8)}, HEAD is ${commit.slice(0, 8)}`);
  const sha = createHash("sha256").update(readFileSync(join(dir, a.name))).digest("hex");
  if (sha !== a.sha256) fail(`${a.name} sha256 does not match its fragment (corrupt copy?)`);
  assets.push({
    name: a.name, os: a.os, arch: a.arch, node_abi: a.node_abi, built_with_node: a.built_with_node,
    sha256: a.sha256, size: a.size,
    url: `https://github.com/${REPO}/releases/download/${tag}/${a.name}`,
  });
}
if (!assets.length) fail(`no artifacts in ${dir} - run scripts/package.mjs on each platform first`);
assets.sort((x, y) => x.name.localeCompare(y.name));

const manifest = {
  name: "grounded", version, tag, commit, notes, published_at: new Date().toISOString(),
  // Companion and the CLI refuse an asset whose os/arch/node_abi do not match the local runtime.
  assets,
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(dir, "SHA256SUMS"), assets.map((a) => `${a.sha256}  ${a.name}`).join("\n") + "\n");
console.log(`[release] ${tag} @ ${commit.slice(0, 8)}: ${assets.map((a) => `${a.os}-${a.arch} (abi ${a.node_abi})`).join(", ")}`);
if (dry) { console.log("[release] dry run - manifest.json and SHA256SUMS written, nothing tagged or published"); process.exit(0); }

run("git", ["tag", "-a", tag, "-m", `Grounded ${version}`]);
run("git", ["push", "origin", tag]);
const body = `${notes}\n\n\`\`\`\n${readFileSync(join(dir, "SHA256SUMS"), "utf8")}\`\`\`\n`;
writeFileSync(join(dir, "NOTES.md"), body);
run("gh", ["release", "create", tag, "-R", REPO, "--title", `Grounded ${version}`, "--notes-file", join(dir, "NOTES.md"),
  ...assets.map((a) => join(dir, a.name)), join(dir, "manifest.json"), join(dir, "SHA256SUMS")]);
console.log(`[release] OK ${tag} published: https://github.com/${REPO}/releases/tag/${tag}`);
console.log(`[release] channel: https://github.com/${REPO}/releases/latest/download/manifest.json`);
