# Ready-made agent configs

Copy-paste these to wire the Grounded MCP server (`grounded-mcp`) into an agent. Or run
`grounded mcp install <target>` to print the same snippet (optionally with `--env KEY=VAL`).

| File | Agent | Paste into |
|---|---|---|
| `claude-code.mcp.json` | Claude Code | `~/.claude.json` (or a project `.mcp.json`) — merge under `mcpServers` |
| `cursor.mcp.json` | Cursor | `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) |
| `codex.config.toml` | Codex | `~/.codex/config.toml` |
| `generic.mcp.json` | any MCP client | your client's MCP servers config |

The `grounded-mcp` binary must be on `PATH` (it ships with `@grounded/cli` / the `ground` install).

## Startup briefs (SessionStart hooks)

To auto-inject a brief at session start, print the hook script with
`grounded hooks print <claude-code|generic>` and wire it per the printed instructions.
The Claude Code hook needs `jq`; the generic wrapper prints the brief to stdout (no `jq`).

> These files are generated from `installSnippet()` in `@grounded/core` and kept in sync by
> `packages/core/src/install/config.test.ts` — edit the generator, not these files.
