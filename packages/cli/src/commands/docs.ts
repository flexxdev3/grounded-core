import { Command } from "commander";
import type { Doc, IngestOptions, IngestReport, ListOptions } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { withStore } from "../util/store.js";
import { c, line, printJson, header, field, truncate } from "../util/output.js";
import { parseInteger } from "../util/parse.js";

function printReport(r: IngestReport, dryRun: boolean): void {
  header(dryRun ? "ingest (dry-run)" : "ingest");
  field("scanned", String(r.scanned));
  field("added", c.green(String(r.added)));
  field("updated", c.cyan(String(r.updated)));
  field("skipped", c.dim(String(r.skipped)));
  field("removed", c.yellow(String(r.removed)));
}

function printDoc(d: Doc): void {
  const meta = c.dim(
    `doc:${d.id} · ${d.source} · ${d.path}#chunk${d.chunkIdx}/${d.totalChunks}${
      d.status !== "active" ? ` · ${d.status}` : ""
    }`,
  );
  line(d.title || c.dim("(untitled)"));
  line(`  ${meta}`);
  if (d.body) line(`  ${c.dim(truncate(d.body, 100))}`);
}

export function docsCommand(global: () => GlobalOpts): Command {
  const cmd = new Command("docs").description("indexed documents");

  cmd
    .command("ingest")
    .description("ingest files/directories")
    .argument("<path...>", "paths to ingest")
    .option("--source <source>", "logical source label")
    .option("--kind <kind>", "kind override")
    .option("--machine <machine>")
    .option("--dry-run", "report changes without writing")
    .action(
      async (
        paths: string[],
        opts: { source?: string; kind?: string; machine?: string; dryRun?: boolean },
      ) => {
        const g = global();
        await withStore(g, async (store) => {
          const io: IngestOptions = {};
          if (opts.source) io.source = opts.source;
          if (opts.kind) io.kind = opts.kind;
          if (opts.machine) io.machine = opts.machine;
          if (opts.dryRun) io.dryRun = true;
          const report = await store.docsIngest(paths, io);
          if (g.json) return printJson(report);
          printReport(report, Boolean(opts.dryRun));
        });
      },
    );

  cmd
    .command("list")
    .description("list indexed docs")
    .option("--source <source>", "filter by source")
    .option("--status <status>", "active | archived | missing")
    .option("--limit <n>", "max results", parseInteger)
    .action(async (opts: { source?: string; status?: string; limit?: number }) => {
      const g = global();
      await withStore(g, async (store) => {
        const lo: ListOptions = {};
        if (opts.source) lo.scope = opts.source;
        if (opts.status) lo.status = opts.status;
        if (opts.limit !== undefined) lo.limit = opts.limit;
        const docs = await store.docsList(lo);
        if (g.json) return printJson(docs);
        if (docs.length === 0) return line(c.dim("no docs"));
        header(`${docs.length} doc(s)`);
        for (const d of docs) printDoc(d);
      });
    });

  cmd
    .command("prune")
    .description("mark or remove docs whose files no longer exist")
    .option("--remove", "delete missing docs (default: just mark)")
    .action(async (opts: { remove?: boolean }) => {
      const g = global();
      await withStore(g, async (store) => {
        const result = await store.docsPrune(opts.remove ? { remove: true } : {});
        if (g.json) return printJson(result);
        header("prune");
        field("missing", c.yellow(String(result.missing)));
        field("removed", c.red(String(result.removed)));
      });
    });

  return cmd;
}
