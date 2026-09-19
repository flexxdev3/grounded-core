# Grounded

**Your agents forget. Grounded doesn't.**

Self-hosted continuity for coding agents. Your agent starts every session knowing nothing — you
re-explain the stack, the conventions, the thing you decided last week, the reason you *didn't* take
the obvious approach. Grounded gives it explicit **facts**, a real work **history**, indexed **docs**,
a shared **vision**, and a startup **brief** — so any agent, in any repo, on any machine, starts
already knowing what happened, why, and where it's going.

Runs entirely on your machine. Every result is cited. No cloud, no account, no telemetry, no "AI brain".

> Not a chat app. Not a vector-DB wrapper. Not an agent framework.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/flexxdev3/grounded-core/master/install.sh | sh
grounded install
```

`grounded install` detects what your host supports, lets you pick **Docker** or **systemd**, creates
the cabinet at `~/.grounded`, and brings the service up on `http://127.0.0.1:7437`. It refuses to
double-install if one is already running.

Then manage it with `grounded status | start | stop | restart | logs | uninstall`.

**Requirements:** Linux or macOS (x64 or arm64), and either Docker or systemd. Node >= 20 for the
systemd path. Nothing else — it works offline, with no model running.

## Use it three ways

- **Console** — `http://127.0.0.1:7437/` to browse and edit vision, facts, sessions, docs, recall, briefs.
- **Agents** — over MCP: `ground_recall`, `ground_brief`, `ground_session_add`, `ground_facts_add`,
  `ground_get`, `ground_timeline`, `ground_impact`, `ground_vision_set`, and more.
- **Scripts** — plain HTTP, no SDK required:

  ```sh
  curl -s localhost:7437/facts  -d '{"fact":"Never push without explicit instruction"}'
  curl -s localhost:7437/recall -d '{"query":"what did we decide about memory"}'
  curl -s localhost:7437/brief  -d '{"agent":"codex","cwd":"'"$PWD"'"}'
  ```

## Wire it into your agent

```sh
grounded mcp install claude-code     # or: codex · cursor · generic
grounded hooks print claude-code     # SessionStart brief wiring (same four targets)
```

Paste the printed snippet into the file it names, restart the agent, and the brief loads at startup
with the `ground_*` tools available. Ready-made configs: [`examples/configs/`](examples/configs).

## What it works with

Everything below is a config switch, never a fork.

| | Supported |
|---|---|
| **Agents** | Claude Code · Codex · Cursor · any MCP client (stdio or streamable HTTP) |
| **Storage** | **SQLite** + sqlite-vec + FTS5 (default — one file, zero services) · **Postgres** + pgvector + tsvector |
| **Embeddings** | **Ollama** (default, `nomic-embed-text`) · OpenAI · **none** — lexical recall, fully offline |
| **Interfaces** | MCP server · web console · HTTP API (OpenAPI at `/openapi.json`) · shell hooks · typed TS client |
| **Platforms** | Linux and macOS, x64 and arm64 |

Grounded is **useful without an LLM**. With `embeddings = "none"` recall falls back to lexical search
and everything else — facts, sessions, docs, briefs — works unchanged. Semantic recall is an
enhancement, never a requirement.

## How recall works

One query hits every lane at once: vector similarity ∪ lexical match → reciprocal rank fusion → boosts
for pinned, important and recent items → per-lane caps → a single score-ranked list. Every hit carries
its source and id, so you can always chase a claim back to where it came from.

| Lane | Holds |
|---|---|
| **vision** | Where it's all going — injected into every brief, never guessed at |
| **facts** | Durable rules and operator truths (explicit, never auto-written) |
| **sessions** | What happened recently |
| **docs** | What you've written down, indexed from your own files |

## Configuration

Config lives at `~/.grounded/config.toml`. The common knobs also work as environment variables, no
file edit needed: `GROUNDED_HOME`, `GROUNDED_API_PORT`, `GROUNDED_API_TOKEN`, `GROUNDED_EMBED_PROVIDER`,
`GROUNDED_EMBED_BASEURL`, `GROUNDED_EMBED_MODEL`.

## Documentation

Full docs — quickstart, concepts, recall ranking, MCP, hooks, API reference, self-hosting:
**[grounded.stunt3d.com](https://grounded.stunt3d.com)**

In this repo: [`CONTRIBUTING.md`](CONTRIBUTING.md) to build from source ·
[`packages/core/CONTRACT.md`](packages/core/CONTRACT.md) for normative engine behavior ·
[`RELEASING.md`](RELEASING.md) for the release procedure.

## License

Apache-2.0.
