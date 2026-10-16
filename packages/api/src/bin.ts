#!/usr/bin/env node
import { bootstrap, loadConfig, openStore } from "@grounded/core";
import { resolveBudget } from "@grounded/core/delivery";
import type { Store } from "@grounded/core/contract";
import { startServer } from "./server.js";
import { createEmbeddingsAddon } from "./addons.js";
import { createServiceDatabox } from "./databox.js";
import { createAddonManager } from "./addon-manager.js";

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
  // Routes hold a stable handle; the add-on swaps the store behind it when it
  // turns vectors on, so the service never restarts to apply a new embedder.
  let current = await openStore(config);
  const store = new Proxy({} as Store, {
    get(_t, key) {
      const v = (current as unknown as Record<PropertyKey, unknown>)[key];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(current) : v;
    },
  });
  const reload = async (): Promise<Store> => {
    const next = await openStore(loadConfig());
    const prev = current;
    current = next;
    // let in-flight requests on the old handle finish before closing it.
    setTimeout(() => void prev.close().catch(() => {}), 10_000).unref();
    return next;
  };
  const embeddingsAddon = createEmbeddingsAddon({ loadConfig, reload });

  const initialDatabox = createServiceDatabox(config, store);
  // Owns the live Databox from here on: the Add-ons page attaches/detaches it.
  const addons = createAddonManager({
    loadConfig,
    embeddings: embeddingsAddon,
    reloadStore: reload,
    embeddingsDevice: async () => (await current.health()).embeddings.device,
    createDatabox: (cfg) => createServiceDatabox(cfg, store),
    ...(initialDatabox ? { initialDatabox } : {}),
  });

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
    embeddingsAddon,
    addons,
  });
  console.log(`grounded-api listening on ${server.url}`);
  console.log(server.ui ? `console: ${server.url}/` : "console: not built (headless)");
  if (token) console.log("auth: bearer token required (except /health)");

  const shutdown = async (): Promise<void> => {
    await server.close();
    await addons.databox()?.close();
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
