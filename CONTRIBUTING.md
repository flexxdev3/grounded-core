# Contributing to Grounded

Thanks for helping. This file is the practical checklist; behavior guarantees live in
[`packages/core/CONTRACT.md`](packages/core/CONTRACT.md) and the architecture in
[`TECH-SPECS.md`](TECH-SPECS.md).

## Requirements

- Node >= 20
- pnpm (the repo is a pnpm workspace; `pnpm-workspace.yaml` at the root)
- Optional: Docker or systemd (only to exercise the installer), Postgres + pgvector (only for the
  Postgres test leg), Ollama (only for embedding-backed recall)

## Build

```sh
pnpm install
pnpm build          # tsc across packages; @grounded/ui builds with vite
pnpm -r typecheck
```

## Test

```sh
pnpm -r test
```

`packages/core` runs one storage lifecycle suite (`store.suite.ts`) against **both** adapters. The
SQLite leg always runs. The Postgres leg runs only when `GROUNDED_TEST_PG_URL` is set — otherwise it
reports skipped, not failed:

```sh
GROUNDED_TEST_PG_URL='postgres://user:pass@host:5432/db' pnpm --filter @grounded/core test
```

Point it at a **scratch database**, never a live one: the suite drops and recreates a hardcoded
`grounded_test` schema at the start of every run. There is no teardown, so the schema stays
inspectable after a failed run.

## Monorepo layout

| Path | Package | Role |
|---|---|---|
| `packages/core` | `@grounded/core` | contract types, storage + embedding adapters, hybrid recall, ingest, config |
| `packages/api` | `@grounded/api` | Hono REST server (`grounded-api` bin); also serves the console |
| `packages/mcp` | `@grounded/mcp` | MCP server, stdio + streamable HTTP (`grounded-mcp` bin) |
| `packages/client` | `@grounded/client` | thin typed `fetch` wrapper over the API |
| `packages/ui` | `@grounded/ui` | the web console (Preact + Vite) |
| `packages/cli` | `@grounded/cli` | the `grounded` command — installer/manager only |
| `examples/` | — | ready-made agent configs and sample docs |
| `scripts/` | — | repo maintenance scripts |

Dependency direction is one-way: `core` depends on nothing in-repo; `api`/`mcp`/`cli` depend on
`core`; `client` depends on `core` types only (`import type`, elided at build); `ui` depends on
`client`; `api` depends on `ui` for the built assets it serves.

The `grounded` CLI is **install/manage only** (`install · status · start · stop · restart · logs ·
uninstall · init · mcp · hooks`). Data operations live on the service surface: console, MCP, HTTP API.
Do not add data verbs back to the CLI.

## Code style

- TypeScript, ESM only (`"type": "module"`), explicit `.js` extensions on relative imports.
- Strict mode; no `any` in exported signatures. Types shared across packages belong in
  `packages/core/src/contract.ts`.
- Config over hardcoding: adapters and endpoints resolve through `config.toml` / `GROUNDED_*` env.
- Every retrieved item carries a citation. No result without a source/id/path.
- `.editorconfig` at the root governs indentation and line endings.
- Public vocabulary is `vision` / `facts` / `sessions` / `docs` / `recall` / `brief`. Keep new
  surfaces in that vocabulary.
- Comments explain *why* a non-obvious constraint exists, not what the line does.

## Commits and pull requests

- Plain commit messages, imperative mood, one concern per commit. No AI attribution or co-author
  trailers.
- Reference the affected package in the subject when it is package-local, e.g.
  `mcp: return delivery rank on ground_facts_add`.
- A PR should state what changed, why, and how it was tested. Keep `pnpm build` and `pnpm -r test`
  green.
- Behavior changes that touch `packages/core/CONTRACT.md` must update it in the same PR.

## Proposing an adapter

Grounded is adaptable by interface, not by fork. There are exactly three plug points; a new adapter
goes behind one of them and changes nothing else.

**1. Embedding provider** — `embed(texts[]) -> vectors[]`, plus `id` and `dims`. Existing:
`ollama` (default), `openai`, `none` (lexical-only). Dimensionality is recorded per store; switching
models is an explicit re-embed, never silent. Add yours under `packages/core/src/embedding/` and
register it in `createEmbeddingProvider`.

**2. Storage / index** — the `Store` repository interface over vision/facts/sessions/docs plus hybrid
recall. Existing: SQLite (`sqlite-vec` + FTS5, single file, default) and Postgres (pgvector +
tsvector). A new adapter must pass the shared `store.suite.ts` unchanged, including recall ordering
(one flat list, fused score descending, `limit` a total across sources) and RRF ranking. The tiered
facts → sessions → active docs → historical docs order survives in `impact()` only. Recall logic that is
portable stays in the engine; only index primitives are per-adapter.

**3. Agent integration** — how a tool talks to a running Grounded service: MCP, HTTP API, hooks, or
the client lib. New integrations wrap the existing HTTP/MCP surface; they must not reach into the
store directly, and they must not require an agent framework as a dependency.

For any of the three, open an issue describing the interface fit before writing a large patch.

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security issues go through
[`SECURITY.md`](SECURITY.md), not the public issue tracker.

## License

By contributing you agree your contributions are licensed under Apache-2.0, matching
[`LICENSE`](LICENSE).
