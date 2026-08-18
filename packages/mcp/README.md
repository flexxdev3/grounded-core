# @grounded/mcp

The Grounded MCP server — gives any MCP-capable agent cited recall, facts, sessions, docs, and
startup briefs, with progressive disclosure.

[Grounded](https://github.com/grounded/grounded) is a self-hosted, source-cited memory layer for AI
agents. Apache-2.0, no telemetry.

## Install

```sh
npm install -g @grounded/mcp    # provides the `grounded-mcp` bin
```

## Usage

Point your agent at the bin. `grounded mcp install <claude-code|codex|cursor|generic>` (from
`@grounded/cli`) prints a ready-to-paste snippet; the generic form is:

```json
{
  "mcpServers": {
    "grounded": {
      "command": "grounded-mcp",
      "env": { "GROUNDED_HOME": "~/.grounded" }
    }
  }
}
```

- **stdio** (default) — run `grounded-mcp` with no extra env.
- **streamable HTTP** — set `GROUNDED_MCP_HTTP_PORT=<port>`; it listens on `127.0.0.1:<port>`,
  stateless (a fresh transport per request).

The bin resolves config with `loadConfig()` and opens the store itself, so it works against either
the SQLite or Postgres adapter with no extra wiring.

Embed it instead:

```js
import { loadConfig, openStore } from "@grounded/core";
import { createServer } from "@grounded/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const config = loadConfig();
const store = await openStore(config);
const server = createServer(store, {
  typicalFactLimit: config.delivery.typicalFactLimit,
  factsReserveTok: config.brief.reserve.facts,
});
await server.connect(new StdioServerTransport());
```

## Tools

Progressive disclosure: `ground_recall` returns compact cited cards (no bodies); pick a `typedId`
and call `ground_get` or `ground_timeline` for detail.

| Tool | What |
|---|---|
| `ground_recall` | hybrid search across facts/sessions/docs → compact cited cards |
| `ground_impact` | reverse lookup, "what depends on X?" — the pre-flight before removing infrastructure |
| `ground_timeline` | sessions around an anchor (session id or query) |
| `ground_get` | full record for a `typedId` (`fact:2`, `session:274`, `doc:1091`) |
| `ground_brief` | scoped startup context — recent sessions + facts + related docs, markdown by default |
| `ground_vision_get` / `ground_vision_set` | read/write the vision for a scope |
| `ground_facts_add` | add or upsert a fact; returns its delivery rank |
| `ground_facts_update` | edit a fact in place by id; re-embeds when text changes |
| `ground_facts_list` | list facts, pinned/importance first; active only by default |
| `ground_facts_delete` | delete a fact by id |
| `ground_session_add` | append a session (work-log entry) |
| `ground_session_delete` | delete a session by id — not reversible |
| `ground_docs_ingest` | ingest/index files or directories; idempotent, returns an `IngestReport` |
| `ground_docs_prune` | reconcile docs rows against disk (mark or remove missing files) |
| `ground_health` | storage + embedding + record-count health report |

## Exports

`createServer(store, opts?)`, plus the config-snippet helpers `installSnippet`,
`allInstallSnippets`, `INSTALL_TARGETS`, `SERVER_KEY`, `BIN_COMMAND` and the `InstallTarget` /
`InstallSnippet` types.

## Links

- Repo README: <https://github.com/grounded/grounded#readme>
- License: Apache-2.0
