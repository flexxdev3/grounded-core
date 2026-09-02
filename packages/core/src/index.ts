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

// Delivery accounting — turns Store.factsDeliveryRank's raw position into the
// wire-shaped signal. Public because every write surface (API, MCP) must render
// the SAME verdict about whether a fact will actually reach an agent; a surface
// that reimplements this can disagree with the engine, which is the exact class
// of silent divergence this whole contract exists to remove.
export { computeDeliveryRank } from "./engine/delivery.js";

// Same reason as computeDeliveryRank above: vision is written by BOTH the API
// and MCP, and before this the cap lived only in the API's request validator —
// so an MCP agent could still store a row the brief would silently cut.
export { visionCapChars, visionCapError } from "./engine/brief.js";

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
