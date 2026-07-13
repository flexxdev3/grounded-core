import pg from "pg";
import type { CloudConfig } from "./config.js";

/**
 * Control-plane pool. Pinned to the accounts schema via search_path so both our
 * own tables and better-auth's tables land there (better-auth issues unqualified
 * DDL/DML). Tenant cabinets get their OWN pools inside openStore — never this one.
 */
export function createControlPool(cfg: CloudConfig): pg.Pool {
  return new pg.Pool({
    connectionString: cfg.pgUrl,
    // -c search_path=<accounts>,public keeps better-auth + our tables in one schema.
    options: `-c search_path=${cfg.accountsSchema},public`,
    max: 10,
  });
}
