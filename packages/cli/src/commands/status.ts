import { Command } from "commander";
import type { GlobalOpts } from "../util/store.js";
import { withStore } from "../util/store.js";
import { c, line, printJson, header, field, ok } from "../util/output.js";

export function statusCommand(global: () => GlobalOpts): Command {
  return new Command("status")
    .description("storage + embeddings health and record counts")
    .action(async () => {
      const g = global();
      await withStore(g, async (store, config) => {
        const h = await store.health();
        if (g.json) return printJson(h);

        header(`grounded — ${h.ok ? c.green("ok") : c.red("degraded")}`);
        field("home", config.home);
        line("");
        field(
          "storage",
          `${h.storage.adapter} · ${ok(h.storage.ok)}${
            h.storage.detail ? c.dim(` · ${h.storage.detail}`) : ""
          }`,
        );
        field(
          "embeddings",
          `${h.embeddings.provider} · ${h.embeddings.dims}d · ${ok(h.embeddings.ok)}${
            h.embeddings.detail ? c.dim(` · ${h.embeddings.detail}`) : ""
          }`,
        );
        line("");
        field("facts", String(h.counts.facts));
        field("sessions", String(h.counts.sessions));
        field("docs", String(h.counts.docs));
      });
    });
}
