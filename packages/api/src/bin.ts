#!/usr/bin/env node
import { loadConfig, openStore } from "@grounded/core";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await openStore(config);

  const token = process.env.GROUNDED_API_TOKEN;
  const port = Number(process.env.GROUNDED_API_PORT ?? 7437);
  const host = process.env.GROUNDED_API_HOST ?? "127.0.0.1";
  const ui = process.env.GROUNDED_API_UI !== "0";

  const server = await startServer({ store, token, port, host, ui });
  console.log(`grounded-api listening on ${server.url}`);
  console.log(server.ui ? `console: ${server.url}/` : "console: not built (headless)");
  if (token) console.log("auth: bearer token required (except /health)");

  const shutdown = async (): Promise<void> => {
    await server.close();
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
