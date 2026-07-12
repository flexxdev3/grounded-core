#!/usr/bin/env node
import { Command, type OptionValues } from "commander";
import { installCommand } from "./commands/install.js";
import {
  statusCommand,
  startCommand,
  stopCommand,
  restartCommand,
  logsCommand,
  uninstallCommand,
} from "./commands/service.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { hooksCommand } from "./commands/hooks.js";
import type { GlobalOpts } from "./util/global.js";

// Exit quietly when a downstream pipe closes early (e.g. `grounded ... | head`).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const program = new Command();

program
  .name("grounded")
  .description("Grounded — self-hosted continuity, run as a service (Docker or systemd)")
  .version("0.1.0")
  .option("--home <path>", "cabinet home (overrides GROUNDED_HOME)")
  .option("--json", "machine-readable JSON output")
  .enablePositionalOptions();

const global = (): GlobalOpts => {
  const opts: OptionValues = program.opts();
  const g: GlobalOpts = {};
  if (typeof opts.home === "string") g.home = opts.home;
  if (opts.json === true) g.json = true;
  return g;
};

// Service lifecycle — the installer surface.
program.addCommand(installCommand(global));
program.addCommand(statusCommand(global));
program.addCommand(startCommand(global));
program.addCommand(stopCommand(global));
program.addCommand(restartCommand(global));
program.addCommand(logsCommand(global));
program.addCommand(uninstallCommand(global));

// Low-level cabinet primitive (also used inside install).
program.addCommand(initCommand(global));

// Agent wiring — data access itself is console / MCP / HTTP now.
program.addCommand(mcpCommand(global));
program.addCommand(hooksCommand(global));

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
