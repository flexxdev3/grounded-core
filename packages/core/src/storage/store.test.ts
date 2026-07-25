import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.js";
import type { GroundedConfig } from "../contract.js";
import { runStoreSuite } from "./store.suite.js";

let home: string;

function sqliteConfig(): GroundedConfig {
  const cfg = defaultConfig(home);
  cfg.storage.adapter = "sqlite";
  cfg.storage.path = join(home, "grounded.db");
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 0;
  return cfg;
}

runStoreSuite({
  label: "sqlite, embeddings=none",
  async beforeSuite() {
    home = mkdtempSync(join(tmpdir(), "grounded-test-"));
  },
  makeConfig: sqliteConfig,
  async afterSuite() {
    rmSync(home, { recursive: true, force: true });
  },
  expected: { adapter: "sqlite", detail: /fts5/ },
});
