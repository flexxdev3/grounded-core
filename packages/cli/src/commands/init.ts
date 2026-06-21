import { Command } from "commander";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, CONFIG_FILENAME, openStore } from "@grounded/core";
import type { GroundedConfig } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { resolveConfig } from "../util/store.js";
import { c, line, printJson, fail } from "../util/output.js";

const CABINET_DIRS = ["facts", "sessions", "docs", "briefs", "exports", "backups"];

function renderConfigToml(cfg: GroundedConfig): string {
  const e = cfg.embeddings;
  const r = cfg.recall;
  const i = cfg.ingest;
  const s = cfg.storage;
  const lines = [
    `home = ${JSON.stringify(cfg.home)}`,
    ``,
    `[storage]`,
    `adapter = ${JSON.stringify(s.adapter)}`,
    s.path !== undefined ? `path = ${JSON.stringify(s.path)}` : null,
    s.url !== undefined ? `url = ${JSON.stringify(s.url)}` : null,
    s.schema !== undefined ? `schema = ${JSON.stringify(s.schema)}` : null,
    ``,
    `[embeddings]`,
    `provider = ${JSON.stringify(e.provider)}`,
    e.baseUrl !== undefined ? `baseUrl = ${JSON.stringify(e.baseUrl)}` : null,
    e.model !== undefined ? `model = ${JSON.stringify(e.model)}` : null,
    e.dims !== undefined ? `dims = ${e.dims}` : null,
    ``,
    `[recall]`,
    `rrfK = ${r.rrfK}`,
    ``,
    `[recall.sourceCaps]`,
    `fact = ${r.sourceCaps.fact}`,
    `session = ${r.sourceCaps.session}`,
    `doc = ${r.sourceCaps.doc}`,
    ``,
    `[recall.boosts]`,
    `pinned = ${r.boosts.pinned}`,
    `importance = ${r.boosts.importance}`,
    `recencyHalfLifeDays = ${r.boosts.recencyHalfLifeDays}`,
    `activeStatus = ${r.boosts.activeStatus}`,
    ``,
    `[ingest]`,
    `ignoreFile = ${JSON.stringify(i.ignoreFile)}`,
    `stripPrivate = ${i.stripPrivate}`,
    `chunkChars = ${i.chunkChars}`,
    `chunkOverlap = ${i.chunkOverlap}`,
    ``,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

export function initCommand(global: () => GlobalOpts): Command {
  return new Command("init")
    .description("create the cabinet (~/.grounded), write default config, run migrations")
    .action(async () => {
      const g = global();
      const home = g.home ?? process.env.GROUNDED_HOME;
      const base = defaultConfig(home);

      try {
        mkdirSync(base.home, { recursive: true });
        for (const dir of CABINET_DIRS) {
          mkdirSync(join(base.home, "cabinet", dir), { recursive: true });
        }
        mkdirSync(join(base.home, "logs"), { recursive: true });
        mkdirSync(join(base.home, "mcp"), { recursive: true });
      } catch (err) {
        return fail(`failed to create cabinet: ${(err as Error).message}`);
      }

      const configPath = join(base.home, CONFIG_FILENAME);
      let wroteConfig = false;
      if (!existsSync(configPath)) {
        try {
          writeFileSync(configPath, renderConfigToml(base), "utf8");
          wroteConfig = true;
        } catch (err) {
          return fail(`failed to write config: ${(err as Error).message}`);
        }
      }

      const config = resolveConfig(g);
      let store;
      try {
        store = await openStore(config);
        await store.init();
      } catch (err) {
        return fail((err as Error).message);
      } finally {
        if (store) await store.close().catch(() => {});
      }

      if (g.json) {
        return printJson({ home: base.home, configPath, wroteConfig });
      }
      line(c.green(`cabinet ready at ${base.home}`));
      line(c.dim(wroteConfig ? `wrote ${configPath}` : `config exists: ${configPath}`));
    });
}
