#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { loadCloudConfig } from "./config.js";
import { createControlPool } from "./db.js";
import { migrateControlPlane } from "./migrate.js";
import { createGateway } from "./gateway.js";

async function main(): Promise<void> {
  const cfg = loadCloudConfig();
  const pool = createControlPool(cfg);
  await migrateControlPlane(pool, cfg);

  const gw = createGateway(pool, cfg);

  const server = serve({ fetch: gw.app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    console.log(`grounded-cloud listening on http://${cfg.host}:${info.port}`);
    console.log(`  base URL: ${cfg.baseUrl}`);
    console.log(`  accounts schema: ${cfg.accountsSchema} · tenant prefix: ${cfg.tenantSchemaPrefix}`);
    console.log(`  auth: /auth/*  ·  account: /account/*  ·  tenant API: /api/*`);
    console.log(`  account UI: ${process.env.CLOUD_UI_DIST ?? "web/dist"} (served at / when built)`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await gw.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
