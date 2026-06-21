import { Command } from "commander";
import type { FullRecord } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { withStore } from "../util/store.js";
import { c, line, printJson, header } from "../util/output.js";
import { parseTypedId } from "../util/parse.js";

function printRecord(rec: FullRecord): void {
  if (rec.sourceType === "fact") {
    const f = rec.record;
    header(`fact:${f.id}${f.pinned ? " ★" : ""}`);
    line(f.fact);
    if (f.detail) line(`\n${f.detail}`);
    line(
      c.dim(
        `\nscope ${f.scope} · category ${f.category} · importance ${f.importance} · status ${f.status}`,
      ),
    );
    line(c.dim(`created ${f.createdAt} · updated ${f.updatedAt}`));
    return;
  }
  if (rec.sourceType === "session") {
    const s = rec.record;
    header(`session:${s.id}`);
    line(s.summary);
    if (s.details) line(`\n${s.details}`);
    if (s.tags && s.tags.length) line(c.cyan(`\ntags: ${s.tags.join(", ")}`));
    line(
      c.dim(
        `\nproject ${s.project ?? "-"} · agent ${s.agent ?? "-"} · machine ${s.machine ?? "-"} · ${s.createdAt}`,
      ),
    );
    return;
  }
  const d = rec.record;
  header(`doc:${d.id} — ${d.title}`);
  line(c.dim(`${d.source} · ${d.path} · chunk ${d.chunkIdx}/${d.totalChunks} · ${d.status}\n`));
  line(d.body);
}

export function getCommand(global: () => GlobalOpts): Command {
  return new Command("get")
    .description("fetch a full record by typed id (e.g. doc:12)")
    .argument("<typedId>", "fact:N | session:N | doc:N", parseTypedId)
    .action(async (typedId) => {
      const g = global();
      await withStore(g, async (store) => {
        const rec = await store.get(typedId);
        if (g.json) return printJson(rec);
        if (!rec) return line(c.yellow(`no record ${typedId}`));
        printRecord(rec);
      });
    });
}
