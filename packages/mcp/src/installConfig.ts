/**
 * Install helpers moved to @grounded/core (dependency-free string building) so the
 * CLI can offer `ground mcp install` without depending on @grounded/mcp.
 * Re-exported here for back-compat with existing importers.
 */
export {
  installSnippet,
  allInstallSnippets,
  INSTALL_TARGETS,
  SERVER_KEY,
  BIN_COMMAND,
} from "@grounded/core";
export type { InstallTarget, InstallSnippet } from "@grounded/core";
