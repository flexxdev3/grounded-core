# Releasing Grounded

Grounded ships as a **service** plus a thin **installer**. Publishing means putting the npm packages
on the registry and (optionally) a Docker image on a container registry. Nothing here auto-publishes —
run the steps deliberately.

## What publishes where

| Package | Role | Consumed by |
|---|---|---|
| `@grounded/core` | engine (storage, embeddings, recall, install kit) | every other package |
| `@grounded/client` | typed HTTP client | embedders/tools |
| `@grounded/ui` | built console assets | `@grounded/api` serves them |
| `@grounded/api` | REST API + console (`grounded-api` bin) | **systemd path** (`npm i -g @grounded/api`) |
| `@grounded/mcp` | MCP server (`grounded-mcp` bin) | MCP agents |
| `@grounded/cli` | the `grounded` installer bin | operators (`npx @grounded/cli`) |

> `@grounded/api` depends on `@grounded/ui` at runtime (it `require.resolve`s the built console). Publish
> **both** or the systemd install serves headless (no console).

## Naming: `npx grounded` is taken

The unscoped `grounded` name is already owned on npm. Use the scope:

```sh
npx @grounded/cli install          # the installer entry point
```

Once installed globally the on-PATH command is still `grounded`. If you want the bare `npx grounded`,
claim a free unscoped launcher name (e.g. publish a tiny wrapper package) — otherwise document
`@grounded/cli`. **Decision pending — see the repo README.**

## Pre-publish checklist

1. Set the real repository URLs — every `package.json` currently uses the placeholder
   `https://github.com/grounded/grounded`. Update `repository` / `homepage` / `bugs`.
2. Bump versions in lockstep (all packages share `0.1.0` today):
   ```sh
   pnpm -r exec npm version <new-version> --no-git-tag-version
   ```
3. Green gate:
   ```sh
   pnpm -r build && pnpm -r test && pnpm smoke
   ```

## Publish the npm packages

`pnpm publish -r` topologically orders the workspace and **rewrites `workspace:*` to real versions** at
pack time (plain `npm publish` does not — never use it here).

```sh
pnpm publish -r --access public          # dry run first:  pnpm publish -r --dry-run
```

Scoped packages already carry `publishConfig.access = "public"`, so they publish public.

> Native `better-sqlite3` builds on the consumer's machine at install time. If it can't compile, recall
> degrades to lexical-only rather than failing — no action needed at publish time.

## Publish the Docker image (optional but recommended)

The installer resolves the image as **local → pull → build-from-source**. Publishing an image means the
Docker path is a fast pull instead of a multi-minute build.

```sh
# build + tag for your registry
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

## After publish — smoke the published artifacts

```sh
npx @grounded/cli@<version> install --method docker --yes   # or systemd-user
grounded status
```
