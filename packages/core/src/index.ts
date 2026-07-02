/**
 * @grounded/core — public entry.
 *
 * The frozen contract (types + interfaces) is always available here.
 * Runtime factories are added by the core implementation:
 *   - loadConfig(overrides?)      -> GroundedConfig
 *   - defaultConfig(home?)        -> GroundedConfig
 *   - openStore(config)           -> Promise<Store>
 *   - createEmbeddingProvider(cfg)-> EmbeddingProvider
 * Consumers (CLI/API/MCP) import these plus any contract type from "@grounded/core".
 */
export * from "./contract.js";

// Runtime implementation surface (provided by core internals).
export { loadConfig, defaultConfig, CONFIG_FILENAME } from "./config.js";
export { openStore } from "./store.js";
export { createEmbeddingProvider } from "./embedding/index.js";

// Install helpers — ready-to-paste MCP server config snippets (dependency-free).
export {
  installSnippet,
  allInstallSnippets,
  INSTALL_TARGETS,
  SERVER_KEY,
  BIN_COMMAND,
} from "./install/config.js";
export type { InstallTarget, InstallSnippet } from "./install/config.js";
