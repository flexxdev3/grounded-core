import pg from "pg";
import { defaultConfig } from "../config.js";
import type { GroundedConfig } from "../contract.js";
import { runStoreSuite } from "./store.suite.js";

const PG_URL = process.env.GROUNDED_TEST_PG_URL;

// Hardcoded, never sourced from env or config — the only thing standing between
// the DROP below and the live `grounded` schema in the same database.
const SCHEMA = "grounded_test";

function pgConfig(): GroundedConfig {
  const cfg = defaultConfig("/tmp/grounded-pg-test");
  cfg.storage.adapter = "postgres";
  cfg.storage.url = PG_URL;
  cfg.storage.schema = SCHEMA;
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 768;
  return cfg;
}

runStoreSuite({
  label: "postgres, embeddings=none",
  skip: !PG_URL,
  async beforeSuite() {
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(`drop schema if exists "${SCHEMA}" cascade`);
    } finally {
      await client.end();
    }
  },
  makeConfig: pgConfig,
  expected: { adapter: "postgres", detail: /pgvector/ },
});
