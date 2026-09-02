#!/usr/bin/env node
import { bootstrap, loadConfig, openStore } from "@grounded/core";
import { resolveBudget } from "@grounded/core/delivery";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  // Self-bootstrap: ensure the cabinet, config, and migrations exist before we
  // serve. Idempotent — a warm cabinet is a no-op. This lets both the Docker
  // container and a systemd ExecStart run this bin directly with no separate
  // init step or ExecStartPre. Honors GROUNDED_HOME (e.g. /cabinet in Docker).
  // A read-only cabinet (e.g. a :ro Docker mount with a hand-managed config)
  // is fine — serve with the existing config instead of dying on mkdir.
  try {
    await bootstrap();
  } catch (err) {
    console.warn(
      `bootstrap skipped (${err instanceof Error ? err.message : err}); serving with existing config`,
    );
  }

  const config = loadConfig();
  const store = await openStore(config);

  const token = process.env.GROUNDED_API_TOKEN;
  const port = Number(process.env.GROUNDED_API_PORT ?? 7437);
  const host = process.env.GROUNDED_API_HOST ?? "127.0.0.1";
  const ui = process.env.GROUNDED_API_UI !== "0";

  const server = await startServer({
    store,
    token,
    port,
    host,
    ui,
    // One resolved table instead of three loose numbers: the write caps, the
    // brief's read reserves and /health's published contract now all come from
    // the same object, so a config.toml edit moves them together.
    budget: resolveBudget(config),
  });
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
