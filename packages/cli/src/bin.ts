#!/usr/bin/env node
import { Command, type OptionValues } from "commander";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { factsCommand } from "./commands/facts.js";
import { sessionCommand } from "./commands/session.js";
import { docsCommand } from "./commands/docs.js";
import { recallCommand } from "./commands/recall.js";
import { getCommand } from "./commands/get.js";
import { briefCommand } from "./commands/brief.js";
import type { GlobalOpts } from "./util/store.js";

const program = new Command();

program
  .name("ground")
  .description("Grounded — self-hosted continuity for multi-agent workspaces")
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

program.addCommand(initCommand(global));
program.addCommand(statusCommand(global));
program.addCommand(factsCommand(global));
program.addCommand(sessionCommand(global));
program.addCommand(docsCommand(global));
program.addCommand(recallCommand(global));
program.addCommand(getCommand(global));
program.addCommand(briefCommand(global));

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
