#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { loadConfig, openStore } from "@grounded/core";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await openStore(config);

  const token = process.env.GROUNDED_API_TOKEN;
  const app = createApp(store, token ? { token } : {});

  const port = Number(process.env.GROUNDED_API_PORT ?? 7437);
  const hostname = process.env.GROUNDED_API_HOST ?? "127.0.0.1";

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`grounded-api listening on http://${hostname}:${info.port}`);
    if (token) console.log("auth: bearer token required (except /health)");
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
