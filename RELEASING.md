# Releasing Grounded

Grounded ships as a **service** plus a thin **installer**. A release is a set of per-platform tarballs
attached to a GitHub Release, plus (optionally) a Docker image on a container registry.
Nothing here auto-publishes — run the steps deliberately.

## Distribution: shell installer, not a package registry

**Grounded is not published to npm.** The unscoped `grounded` name on npm belongs to an unrelated
package (`micimize`, `0.0.1-alpha`, untouched since 2022-05-04), and the `@grounded/*` scope is
deliberately left unclaimed. Users install with:

```sh
curl -fsSL https://raw.githubusercontent.com/flexxdev3/grounded-core/master/install.sh | sh
```

`install.sh` resolves `os-arch`, downloads the matching tarball, verifies it against `SHA256SUMS`,
unpacks to `~/.grounded/lib/<version>/`, flips the `current` symlink, and symlinks `grounded` into
`~/.local/bin`. Upgrade and rollback are a symlink flip; `grounded uninstall` removes both.

> The repo must be **public** for `curl | sh` to fetch anonymously — release assets and the raw
> `install.sh` URL on a private repo require an auth header.

## What ships in a tarball

The workspace packages are build inputs, not release artifacts. Each is bundled into one file:

| Package | Role | Ships as |
|---|---|---|
| `@grounded/core` | engine (storage, embeddings, recall, install kit) | linked into every bundle |
| `@grounded/client` | typed HTTP client | linked into `ui` |
| `@grounded/ui` | built console assets | linked into `api.mjs` |
| `@grounded/api` | REST API + console (`grounded-api` bin) | `lib/api.mjs` |
| `@grounded/mcp` | MCP server (`grounded-mcp` bin) | `lib/mcp.mjs` |
| `@grounded/cli` | the `grounded` installer bin | `lib/cli.mjs` + `bin/grounded` shim |

```
grounded-<version>-<os>-<arch>.tar.gz
├── bin/grounded                    # shim: exec "$NODE" "$DIR/lib/cli.mjs" "$@"
├── lib/{cli,api,mcp}.mjs
└── lib/native/
    ├── better_sqlite3.node         # 2.1 MB, keyed to platform + arch + Node ABI
    └── vec0.so                     # 160 KB, platform + arch only
```

Target ~2–3 MB compressed per tarball. Matrix: `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`.

> **`better_sqlite3.node` is ABI-keyed** — a tarball built against Node 20 fails on Node 24. Either ship
> one `.node` per supported ABI and select at runtime from `process.versions.modules`, or state the
> supported Node range in the release notes and have `install.sh` enforce it.
>
> The natives are optional payload: `packages/core/src/store.ts` imports the adapter with `await import`,
> so a Postgres-only install never loads `better-sqlite3`.

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

```sh
# per platform in the matrix:
#   bundle each bin, vendor lib/native/, tar, then:
sha256sum grounded-<version>-*.tar.gz > SHA256SUMS

git tag v<version> && git push origin v<version>
gh release create v<version> grounded-<version>-*.tar.gz SHA256SUMS \
  --title "v<version>" --notes-file NOTES.md
```

Paste the contents of `SHA256SUMS` into the release body as well. The script and the checksums must not
share a single point of compromise — `curl | sh` is a supply-chain surface and the sums are the floor.

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
curl -fsSL https://raw.githubusercontent.com/flexxdev3/grounded-core/master/install.sh | sh
grounded install --method docker --yes    # or systemd-user
grounded status
```

Verify the checksum path actually fails closed: corrupt a byte of a downloaded tarball and confirm
`install.sh` aborts non-zero and leaves nothing in `~/.grounded/lib`.
