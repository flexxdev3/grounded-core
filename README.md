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
npx grounded init                         # creates ~/.grounded with a local SQLite cabinet
ground facts add "Never push without explicit instruction"
ground session add --project demo "Initialized the demo workspace"
ground docs ingest ./docs ./notes
ground recall "what did we decide about memory"
ground brief --agent codex --cwd "$PWD"
ground mcp install                        # wire Grounded into your agent over MCP
```

Works fully offline with `embeddings = "none"` (lexical recall). Add Ollama or OpenAI embeddings for
semantic recall.

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

## Development

```sh
pnpm install
pnpm build
pnpm test
```

See [`CLAUDE.md`](CLAUDE.md) for the phased roadmap and [`AGENTS.md`](AGENTS.md) for the engine reference.

## License

Apache-2.0.
