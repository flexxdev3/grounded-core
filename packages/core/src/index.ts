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

// Cabinet bootstrap — materializes ~/.grounded (shared by installer, Docker, systemd).
export {
  bootstrap,
  renderConfigToml,
  resolveHome,
  CABINET_DIRS,
} from "./install/bootstrap.js";
export type { BootstrapOptions, BootstrapResult } from "./install/bootstrap.js";

// Instance detection — anti-double-install guard (health + docker + systemd + manifest).
export {
  detect,
  probeHealth,
  detectDocker,
  detectSystemd,
  readManifest,
  writeManifest,
  manifestPath,
  DEFAULT_PORT,
  DOCKER_NAME,
  DOCKER_LABEL,
  SYSTEMD_UNIT,
} from "./install/detect.js";
export type {
  InstallMethod,
  InstallManifest,
  HealthProbe,
  DetectResult,
  Evidence,
} from "./install/detect.js";

// Service unit rendering — systemd unit + docker invocation from one config.
export {
  renderSystemdUnit,
  renderDockerRunArgs,
  renderComposeYaml,
  systemdUnitPath,
} from "./install/unit.js";
export type { UnitOptions, ServiceScope } from "./install/unit.js";
