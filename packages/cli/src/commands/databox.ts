import { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILENAME, DEFAULT_PORT, detect, loadConfig, resolveHome } from "@grounded/core";
import { duckHealth, scanItems, validateBoxes, writeDataboxConfig, type BoxConfig } from "@grounded/databox";
import type { GlobalOpts } from "../util/global.js";
import { c, line, header, field, fail } from "../util/output.js";
import { confirm, interactive } from "../util/prompt.js";
import { restartService } from "../util/service.js";
import { resolveMethod } from "./service.js";

/**
 * `grounded addon add databox`: check the DuckDB payload, write `[databox]`
 * (+ any `--box name=root`) into config.toml, restart the service so it loads.
 */
export async function addDatabox(
  g: GlobalOpts,
  opts: { box?: string[]; description?: string; yes?: boolean; restart?: boolean },
): Promise<void> {
  const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
  const health = await duckHealth();
  header("Databox add-on");
  field("DuckDB", health.ok ? c.green(health.detail) : c.yellow(health.detail));
  if (!health.ok) {
    fail(
      "this install is missing DuckDB (@duckdb/node-api, an optional dependency). " +
        "Reinstall Grounded with optional dependencies (`pnpm install` in a source checkout), then retry.",
    );
  }

  const cfg = loadConfig({ home });
  const boxes = new Map<string, BoxConfig>((cfg.databox?.box ?? []).map((b) => [b.name, b]));
  for (const spec of opts.box ?? []) {
    const eq = spec.indexOf("=");
    if (eq < 1) fail(`--box takes name=folder (got "${spec}")`);
    const name = spec.slice(0, eq).trim();
    const root = resolve(spec.slice(eq + 1).trim()).replaceAll("\\", "/");
    boxes.set(name, { name, root, ...(opts.description ? { description: opts.description } : {}) });
  }
  let list: BoxConfig[];
  try {
    list = validateBoxes([...boxes.values()]);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  for (const b of list) {
    const scan = existsSync(b.root) ? scanItems(b.root) : null;
    field(
      `box ${b.name}`,
      `${b.root}  ${scan === null ? c.yellow("(folder missing)") : scan.files === 0 ? c.yellow("(no items/*.json yet)") : c.dim(`${scan.files} items`)}`,
    );
  }

  const path = join(home, CONFIG_FILENAME);
  writeDataboxConfig(path, { enabled: true, box: list });
  line(c.green(`Databox is on in ${path}.`));
  if (list.length === 0) line(c.dim("Add a box with `grounded addon add databox --box <name>=<folder>`."));

  const d = await detect({ home, port: DEFAULT_PORT });
  if (!d.running) return line(c.dim("Start Grounded (`grounded start`) to load it."));
  if (opts.restart === false) return line(c.dim("Restart Grounded (`grounded restart`) to load it."));
  if (!opts.yes && interactive && !(await confirm("Restart Grounded now to load it?", true))) {
    return line(c.dim("Restart later with `grounded restart`."));
  }
  const code = await restartService(await resolveMethod(home, DEFAULT_PORT), home);
  if (code !== 0) fail(`restart failed (exit ${code})`);
  line(c.green("restarted. Boxes index in the background; the console's Databox tab shows them."));
}
