import { ConfigError } from "./contract.js";
import type { GroundedConfig, Store } from "./contract.js";
import { createEmbeddingProvider } from "./embedding/index.js";

export async function openStore(config: GroundedConfig): Promise<Store> {
  const embedder = createEmbeddingProvider(config);
  switch (config.storage.adapter) {
    case "sqlite": {
      const { openSqliteStore } = await import("./storage/sqlite.js");
      return openSqliteStore(config, embedder);
    }
    case "postgres": {
      const { openPostgresStore } = await import("./storage/postgres.js");
      return openPostgresStore(config, embedder);
    }
    default:
      throw new ConfigError(`unknown storage adapter: ${String(config.storage.adapter)}`);
  }
}
