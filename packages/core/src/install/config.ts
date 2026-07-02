/**
 * Install helpers — ready-to-paste MCP server config snippets.
 * The server runs as the `grounded-mcp` bin over stdio.
 *
 * Lives in core (dependency-free string building) so the CLI can offer
 * `ground mcp install` without depending on @grounded/mcp.
 */

export const SERVER_KEY = "grounded";
export const BIN_COMMAND = "grounded-mcp";

export type InstallTarget = "claude-code" | "codex" | "cursor" | "generic";

export interface InstallSnippet {
  target: InstallTarget;
  /** human label. */
  label: string;
  /** where the operator pastes this. */
  file: string;
  /** the snippet body (already formatted: JSON or TOML). */
  snippet: string;
}

interface StdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function stdioServer(env?: Record<string, string>): StdioServer {
  const server: StdioServer = { command: BIN_COMMAND, args: [] };
  if (env) server.env = env;
  return server;
}

/** Claude Code / Cursor / generic share the `mcpServers` JSON shape. */
function jsonServersSnippet(env?: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: stdioServer(env) } }, null, 2);
}

/** Codex uses TOML (`~/.codex/config.toml`) with `[mcp_servers.<name>]`. */
function codexTomlSnippet(env?: Record<string, string>): string {
  const lines = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = "${BIN_COMMAND}"`,
    `args = []`,
  ];
  if (env && Object.keys(env).length > 0) {
    const pairs = Object.entries(env)
      .map(([k, v]) => `${k} = "${v}"`)
      .join(", ");
    lines.push(`env = { ${pairs} }`);
  }
  return lines.join("\n");
}

/** Build a single snippet for one target. */
export function installSnippet(target: InstallTarget, env?: Record<string, string>): InstallSnippet {
  switch (target) {
    case "claude-code":
      return {
        target,
        label: "Claude Code",
        file: "~/.claude.json (or project .mcp.json)",
        snippet: jsonServersSnippet(env),
      };
    case "cursor":
      return {
        target,
        label: "Cursor",
        file: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
        snippet: jsonServersSnippet(env),
      };
    case "codex":
      return {
        target,
        label: "Codex",
        file: "~/.codex/config.toml",
        snippet: codexTomlSnippet(env),
      };
    case "generic":
      return {
        target,
        label: "Generic MCP client",
        file: "your client's MCP servers config",
        snippet: jsonServersSnippet(env),
      };
  }
}

export const INSTALL_TARGETS: InstallTarget[] = ["claude-code", "codex", "cursor", "generic"];

/** All snippets, keyed by target. */
export function allInstallSnippets(env?: Record<string, string>): Record<InstallTarget, InstallSnippet> {
  const out = {} as Record<InstallTarget, InstallSnippet>;
  for (const t of INSTALL_TARGETS) out[t] = installSnippet(t, env);
  return out;
}
