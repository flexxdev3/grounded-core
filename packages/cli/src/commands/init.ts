import { Command } from "commander";
import { bootstrap } from "@grounded/core";
import type { GlobalOpts } from "../util/global.js";
import { c, line, printJson, fail } from "../util/output.js";

export function initCommand(global: () => GlobalOpts): Command {
  return new Command("init")
    .description("create the cabinet (~/.grounded), write default config, run migrations")
    .action(async () => {
      const g = global();
      const home = g.home ?? process.env.GROUNDED_HOME;

      let result;
      try {
        result = await bootstrap({ home });
      } catch (err) {
        return fail((err as Error).message);
      }

      if (g.json) return printJson(result);
      line(c.green(`cabinet ready at ${result.home}`));
      line(
        c.dim(
          result.wroteConfig
            ? `wrote ${result.configPath}`
            : `config exists: ${result.configPath}`,
        ),
      );
    });
}
