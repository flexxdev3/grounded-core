# Releasing Grounded

Grounded ships as a **service** plus a thin **installer**. A release is a set of per-platform tarballs
attached to a GitHub Release, plus (optionally) a Docker image on a container registry.
Nothing here auto-publishes — run the steps deliberately.

## Distribution: shell installer, not a package registry

**Grounded is not published to npm.** The unscoped `grounded` name on npm belongs to an unrelated
package (`micimize`, `0.0.1-alpha`, untouched since 2022-05-04), and the `@grounded/*` scope is
deliberately left unclaimed. Users install with:

```sh
curl -fsSL https://getgrounded.dev/install.sh | sh          # 302 -> the raw file below
curl -fsSL https://raw.githubusercontent.com/flexxdev3/grounded-core/master/install.sh | sh
curl -fsSL https://getgrounded.dev/install.sh | sh -s -- --version 0.1.0 --prefix ~/bin
```

`install.sh` (POSIX sh, Linux + macOS; Windows uses the Companion app) resolves `os-arch`, reads
`manifest.json` from the release (`latest`, or `v<version>` with `--version` / `GROUNDED_VERSION`), and
refuses when there is no `<os>-<arch>` `.tar.gz` asset. It then requires `node` (or `$NODE`) whose
`process.versions.modules` equals the asset's `node_abi` — a mismatch exits naming the Node major from
`built_with_node`; it never installs Node. The tarball is downloaded to a temp dir and its size and sha256
must match the manifest **and** `SHA256SUMS` before anything under `~/.grounded` is touched (the installer
only ever writes runtime there; user data lives in `~/Grounded/Cabinet` and is never touched by it). It unpacks to
`${GROUNDED_HOME:-~/.grounded}/lib/<version>/`, atomically flips `lib/current` (a relative symlink), and writes
a small `grounded` launcher script into `--prefix` (default `~/.local/bin`) that execs
`lib/current/bin/grounded` — a script, not a symlink, because the tarball's shim locates `lib/` from its own
path. Any failure removes what the run created. Re-running is idempotent; upgrade and rollback are a
`current` flip (old versions stay in `lib/`). It starts no service — it ends by pointing at `grounded install`.

`grounded uninstall` removes the **service** only; `--purge` deletes the whole home (including `lib/`).
Neither removes the launcher in `~/.local/bin` — delete it by hand.

> The repo must be **public** for `curl | sh` to fetch anonymously — release assets and the raw
> `install.sh` URL on a private repo require an auth header.

## What ships in an artifact

`scripts/package.mjs` builds one artifact for the platform it runs on. Natives are ABI-keyed, so each platform
builds on its own box: **windows-x64 on vivobook, linux-x64 on arch1, darwin-arm64 on the macbook.**

```
grounded-<version>-<os>-<arch>.{zip|tar.gz}      # zip on windows, tar.gz elsewhere; unpacks flat
├── bin/grounded, bin/grounded.cmd               # shims: node lib/cli.mjs
├── lib/{api,cli,mcp}.mjs                        # esbuild bundles of the workspace bins
├── lib/node_modules/                            # only what cannot be bundled:
│   ├── better-sqlite3 (+ bindings, file-uri-to-path)   better_sqlite3.node, ABI-keyed
│   ├── sqlite-vec + sqlite-vec-<os>-<arch>
│   └── @grounded/ui                             # built console, resolved by the API at runtime
├── hooks/                                       # agent session-start hooks
└── release.json                                 # version, commit, os, arch, node_abi
```

~2 MB per artifact. Add-on runtimes (onnxruntime-node, @duckdb/node-api) are **not** in the base artifact; add-ons
install their own dependencies. The CLI resolves the shipped API at `$GROUNDED_HOME/lib/current/lib/api.mjs`.

`package.mjs` refuses a dirty tree (the artifact must match a commit), smokes the staged runtime (natives load,
console resolves, `cli --version`), then writes `release/<version>/<artifact>` plus `<artifact>.json` — the
fragment `release.mjs` folds into the manifest.

> **`node_abi` is per asset.** A Node 24 build (ABI 137) fails on Node 26 (ABI 147). The manifest records
> each asset's ABI; updaters must refuse a mismatch instead of installing it.

## Pre-release checklist

1. Confirm `repository` / `homepage` / `bugs` in every `package.json` point at
   `https://github.com/flexxdev3/grounded-core`.
2. Bump versions in lockstep (all packages share `0.1.0` today):
   ```sh
   pnpm -r exec npm version <new-version> --no-git-tag-version
   ```
3. Green gate:
   ```sh
   pnpm -r build && pnpm -r test && pnpm smoke
   ```
   Set `GROUNDED_TEST_PG_URL` (scratch database) before running the gate on any release that touches
   migrations — without it, `packages/core`'s Postgres storage-lifecycle suite silently skips and the
   gate isn't actually gating the Postgres adapter.

## Cut the release

Releases, not commits, are the update channel (same contract as ModControl). Every artifact must be built from
the commit being tagged.

```sh
# 1. commit + push master. 2. on EACH platform box, from that commit:
node scripts/package.mjs
# 3. copy each release/<version>/<artifact> and <artifact>.json to arch1's release/<version>/, then on arch1:
node scripts/release.mjs --notes "what changed" --dry-run   # verifies commits + hashes, writes manifest.json, SHA256SUMS
node scripts/release.mjs --notes "what changed"             # tags v<version>, pushes the tag, gh release create
```

The channel is `https://github.com/flexxdev3/grounded-core/releases/latest/download/manifest.json`:

```json
{ "name": "grounded", "version": "0.1.0", "tag": "v0.1.0", "commit": "…", "notes": "…", "published_at": "…",
  "assets": [{ "name": "grounded-0.1.0-windows-x64.zip", "os": "windows", "arch": "x64", "node_abi": "137",
               "sha256": "…", "size": 2097152, "url": "https://github.com/…/releases/download/v0.1.0/…" }] }
```

`SHA256SUMS` is attached and pasted into the release body. The script and the checksums must not share a single
point of compromise — `curl | sh` is a supply-chain surface and the sums are the floor.

## Publish the Docker image (optional but recommended)

The installer resolves the image as **local → pull → build-from-source**. Publishing an image means the
Docker path is a fast pull instead of a multi-minute build.

```sh
docker build -t ghcr.io/<org>/grounded:<version> -t ghcr.io/<org>/grounded:latest .
docker push ghcr.io/<org>/grounded:<version>
docker push ghcr.io/<org>/grounded:latest
```

Then point installs at it, either per-invocation or as a default:

```sh
grounded install --method docker --image ghcr.io/<org>/grounded:latest
# or:
GROUNDED_IMAGE=ghcr.io/<org>/grounded:latest grounded install
```

A bare local tag (`grounded:latest`, no registry/namespace) is treated as build-only; a ref containing a
`/` is treated as pullable. To bake a published default into the installer, set the `IMAGE` default in
`packages/cli/src/util/service.ts` (or ship `GROUNDED_IMAGE` in the environment).

## After release — smoke the published artifacts

On a machine that has never built this repo:

```sh
curl -fsSL https://getgrounded.dev/install.sh | sh
grounded install --method docker --yes    # or systemd-user
grounded status
```

Verify the checksum path actually fails closed: corrupt a byte of a downloaded tarball and confirm
`install.sh` aborts non-zero and leaves nothing in `~/.grounded/lib`.
