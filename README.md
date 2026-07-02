# Grounded

**Self-hosted continuity for multi-agent workspaces.**

Grounded gives coding agents and operators a shared, source-cited memory layer: explicit **facts**,
recent **sessions**, indexed **docs**, hybrid **recall**, and startup **briefs**. It runs locally on
SQLite (zero services) or Postgres + pgvector, works through CLI / MCP / hooks, and stays useful
without any LLM.

> Not a brain. Not a chat app. Not a vector-DB wrapper. Not an agent framework. Not cloud-first memory magic.

## Why

Most memory systems try to infer too much. Grounded separates memory by responsibility and keeps the
operator in control — the system retrieves, ranks, cites, and injects:

| Lane | Purpose |
|---|---|
| **facts** | Durable hard rules / operator truths (explicit) |
| **sessions** | What happened recently (chronological work log) |
| **docs** | What you've written down (indexed files/notes) |
| **recall** | Find relevant prior context (hybrid vector + lexical) |
| **brief** | Load the right context before work starts |

## Quick start

```sh
ground init                               # creates ~/.grounded with a local SQLite cabinet
ground facts add "Never push without explicit instruction"
ground session add --project demo "Initialized the demo workspace"
ground docs ingest ./docs ./notes
ground recall "what did we decide about memory"
ground brief --agent codex --cwd "$PWD"
ground mcp install claude-code            # print a ready-to-paste MCP server config
ground hooks print claude-code            # print a SessionStart brief hook + wiring
```

Works fully offline with `embeddings = "none"` (lexical recall). Add Ollama or OpenAI embeddings for
semantic recall. The bins read these env knobs (no config edit needed):
`GROUNDED_HOME`, `GROUNDED_EMBED_PROVIDER`, `GROUNDED_EMBED_BASEURL`, `GROUNDED_EMBED_MODEL`.

## Install

`npx grounded` (published packages) is coming. Until then, install locally from this repo:

```sh
pnpm install && pnpm build                # build all packages to dist/
pnpm smoke                                # end-to-end check (init → recall → brief → mcp → hooks)

# pack all packages (pnpm rewrites workspace:* to real versions), then install them together:
mkdir -p /tmp/grounded-tgz
for p in core cli api mcp client; do pnpm -C packages/$p pack --pack-destination /tmp/grounded-tgz; done
npm i -g /tmp/grounded-tgz/grounded-*.tgz  # → `ground`, `grounded-api`, `grounded-mcp` on PATH
ground init
```

> Install **all tarballs in one `npm i -g`** so the inter-package deps resolve from the set — and use
> `pnpm pack`, not `npm pack` (the latter leaves `workspace:*` unresolvable). During development you can
> skip the install and run the bins straight from `dist/` (that's what `pnpm smoke` does). On a fresh
> machine `better-sqlite3` builds a native module on install; if it can't, recall degrades to
> lexical-only rather than failing.

## Wire into an agent (MCP + briefs)

1. `ground mcp install <claude-code|codex|cursor|generic>` → paste the snippet into the printed file.
2. `ground hooks print <claude-code|generic>` → paste the SessionStart hook + wiring (Claude Code
   needs `jq`; the generic wrapper prints the brief to stdout).
3. Restart the agent — the brief loads at startup and the `ground_*` MCP tools are available.

Ready-made copies of all four configs live in [`examples/configs/`](examples/configs).

## Architecture

Three plug points, all swappable by config — never by fork:

- **Embeddings** — `ollama` (default) · `openai` · `none` (lexical-only)
- **Storage / index** — `sqlite` (default; sqlite-vec + FTS5, single file) · `postgres` (pgvector + tsvector)
- **Agent integration** — MCP (stdio + HTTP) · hooks · CLI · client lib

The homelab stack (Ollama + Postgres) is just one adapter set — the default, never hardcoded into core.

## Packages

| Package | What |
|---|---|
| [`@grounded/core`](packages/core) | types/contract, storage + embedding adapters, hybrid recall engine, ingest |
| [`@grounded/cli`](packages/cli) | the `ground` command |
| [`@grounded/api`](packages/api) | Hono REST server |
| [`@grounded/mcp`](packages/mcp) | MCP server (progressive disclosure) |
| [`@grounded/client`](packages/client) | thin typed `fetch` wrapper over the API |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

See [`CLAUDE.md`](CLAUDE.md) for the phased roadmap and [`AGENTS.md`](AGENTS.md) for the engine reference.

## License

Apache-2.0.
