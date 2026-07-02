import { Command } from "commander";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { openStore } from "@grounded/core";
import { startServer } from "@grounded/api";
import type { GlobalOpts } from "../util/store.js";
import { resolveConfig } from "../util/store.js";
import { c, line, fail } from "../util/output.js";

/** Best-effort open the URL in the default browser; never fatal. */
function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // headless box / no browser — the URL is printed anyway
  }
}

export function uiCommand(global: () => GlobalOpts): Command {
  return new Command("ui")
    .description("serve the Grounded console (web UI) over the local API")
    .option("--port <n>", "port to listen on", (v) => Number(v), 7437)
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("--token <token>", "require this bearer token (except /health)")
    .option("--no-open", "do not open a browser")
    .action(async (opts: { port: number; host: string; token?: string; open: boolean }) => {
      const g = global();
      const config = resolveConfig(g);
      const store = await openStore(config);

      const server = await startServer({
        store,
        port: opts.port,
        host: opts.host,
        token: opts.token,
        ui: true,
      });

      if (!server.ui) {
        await server.close();
        await store.close();
        return fail("console assets not found — build @grounded/ui (pnpm --filter @grounded/ui build)");
      }

      line(c.green(`Grounded console → ${server.url}`));
      line(c.dim(`cabinet: ${config.home} · storage: ${config.storage.adapter}`));
      if (opts.token) line(c.dim("auth: bearer token required"));
      line(c.dim("Ctrl-C to stop."));
      if (opts.open) openBrowser(server.url);

      const shutdown = async (): Promise<void> => {
        await server.close();
        await store.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
