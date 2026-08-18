# Grounded

**Self-hosted continuity for multi-agent workspaces.**

Grounded gives coding agents and operators a shared, source-cited memory layer: a shared **vision**,
explicit **facts**, recent **sessions**, indexed **docs**, hybrid **recall**, and startup **briefs**. It runs locally on
SQLite (zero services) or Postgres + pgvector as a **persistent service** you talk to over MCP, HTTP,
or the web console — and stays useful without any LLM.

> Not a brain. Not a chat app. Not a vector-DB wrapper. Not an agent framework. Not cloud-first memory magic.

## Why

Most memory systems try to infer too much. Grounded separates memory by responsibility and keeps the
operator in control — the system retrieves, ranks, cites, and injects:

| Lane | Purpose |
|---|---|
| **vision** | Where it's all going (Global Vision + one Project Vision per project; always in the brief) |
| **facts** | Durable hard rules / operator truths (explicit) |
| **sessions** | What happened recently (chronological work log) |
| **docs** | What you've written down (indexed files/notes) |
| **recall** | Find relevant prior context (hybrid vector + lexical) |
| **brief** | Load the right context before work starts |

## Quick start

Grounded runs as a persistent service. One command stands it up — it detects what your host can do
(Docker or systemd), lets you choose, creates `~/.grounded`, and refuses to double-install if one is
already running:

```sh
grounded install        # detect → pick Docker or systemd → cabinet + service on http://127.0.0.1:7437
grounded status         # is it running, how, and healthy?
grounded mcp install claude-code   # print a ready-to-paste MCP server config
```

Then use it three ways — no local data CLI needed:

- **Console** — open `http://127.0.0.1:7437/` to browse/add vision, facts, sessions, docs, recall, and briefs.
- **Agents** — over MCP (`ground_recall`, `ground_session_add`, `ground_brief`, …).
- **Scripts** — plain HTTP:

  ```sh
  curl -s localhost:7437/facts -d '{"fact":"Never push without explicit instruction"}'
  curl -s localhost:7437/recall -d '{"query":"what did we decide about memory"}'
  curl -s localhost:7437/brief  -d '{"agent":"codex","cwd":"'"$PWD"'"}'
  ```

Manage the service with `grounded start | stop | restart | logs | uninstall`. Works fully offline with
`embeddings = "none"` (lexical recall); add Ollama or OpenAI for semantic recall. Env knobs (no config
edit needed): `GROUNDED_HOME`, `GROUNDED_API_PORT`, `GROUNDED_API_TOKEN`, `GROUNDED_EMBED_PROVIDER`,
`GROUNDED_EMBED_BASEURL`, `GROUNDED_EMBED_MODEL`.

## Install methods

`grounded install` offers only what your host supports:

| Method | What it does | When |
|---|---|---|
| **Docker** | builds the image (first run) and runs a labelled, `restart=unless-stopped` container mounting `~/.grounded` | Docker daemon reachable — the default |
| **systemd (user)** | `npm i -g @grounded/api`, writes `~/.config/systemd/user/grounded.service`, `enable --now` | no root; runs as you (`loginctl enable-linger` to survive logout) |
| **systemd (system)** | same, at `/etc/systemd/system` via sudo | always-on; needs root/sudo |

Once published the installer runs via `npx @grounded/cli install` (the unscoped `grounded` name is taken
on npm; the on-PATH command after a global install is still `grounded`). From this repo today, build
first (`pnpm install && pnpm build`) so the installer can build the Docker image or link the
`@grounded/api` bin, then run `node packages/cli/dist/bin.js install`. Point the Docker path at a
published image with `--image <ref>` or `GROUNDED_IMAGE`; otherwise it builds from source. On a fresh
machine `better-sqlite3` builds a native module; if it can't, recall degrades to lexical-only rather than
failing. Full release steps: [`RELEASING.md`](RELEASING.md).

## Wire into an agent (MCP + briefs)

1. `grounded mcp install <claude-code|codex|cursor|generic>` → paste the snippet into the printed file.
2. `grounded hooks print <claude-code|generic>` → paste the SessionStart hook + wiring (Claude Code
   needs `jq`; the generic wrapper prints the brief to stdout).
3. Restart the agent — the brief loads at startup and the `ground_*` MCP tools are available.

Ready-made copies of all four configs live in [`examples/configs/`](examples/configs).

## Architecture

Three plug points, all swappable by config — never by fork:

- **Embeddings** — `ollama` (default) · `openai` · `none` (lexical-only)
- **Storage / index** — `sqlite` (default; sqlite-vec + FTS5, single file) · `postgres` (pgvector + tsvector)
- **Agent integration** — MCP (stdio + HTTP) · web console · HTTP API · hooks · client lib

The homelab stack (Ollama + Postgres) is just one adapter set — the default, never hardcoded into core.

## Packages

| Package | What |
|---|---|
| [`@grounded/core`](packages/core) | types/contract, storage + embedding adapters, hybrid recall engine, ingest |
| [`@grounded/cli`](packages/cli) | the `grounded` installer — stand up & manage the service |
| [`@grounded/api`](packages/api) | Hono REST server |
| [`@grounded/mcp`](packages/mcp) | MCP server (progressive disclosure) |
| [`@grounded/client`](packages/client) | thin typed `fetch` wrapper over the API |
| [`@grounded/ui`](packages/ui) | the web console (Preact); its built assets are served by `@grounded/api` |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

`packages/core` runs the storage lifecycle suite against both adapters (`store.suite.ts`). The Postgres
leg only runs when `GROUNDED_TEST_PG_URL` is set — otherwise it reports skipped, not failed:

```sh
GROUNDED_TEST_PG_URL='postgres://user:pass@host:5432/db' pnpm --filter @grounded/core test
```

Point it at a **scratch database**, never a live one — the suite drops and recreates a hardcoded
`grounded_test` schema at the start of every run (no teardown, so it's inspectable after a failed run).

Contributing guide: [`CONTRIBUTING.md`](CONTRIBUTING.md). Architecture and engine reference:
[`TECH-SPECS.md`](TECH-SPECS.md); normative behavior: [`packages/core/CONTRACT.md`](packages/core/CONTRACT.md).

## License

Apache-2.0.
