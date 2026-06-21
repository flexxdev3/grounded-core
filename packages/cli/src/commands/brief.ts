import { Command } from "commander";
import type { BriefOptions, BriefResult } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { withStore } from "../util/store.js";
import { c, line, printJson, truncate } from "../util/output.js";

function renderMarkdown(b: BriefResult): void {
  if (b.text) {
    line(b.text);
    return;
  }
  line("=== STARTUP CONTEXT ===");
  line(b.startupNote);
  line("\n=== MOST RECENT WORK (newest first) ===");
  for (const s of b.recentSessions) {
    line(`- ${s.summary}${s.project ? ` (${s.project})` : ""} — ${s.createdAt}`);
  }
  line("\n=== FACTS BRAIN (curated) ===");
  for (const f of b.facts) {
    line(`- ${f.pinned ? "★ " : ""}${f.fact}`);
  }
  if (b.relatedDocs.length) {
    line("\n=== RELATED DOCS ===");
    for (const d of b.relatedDocs) {
      line(`- ${d.typedId} ${truncate(d.title, 70)} (${d.citation})`);
    }
  }
}

export function briefCommand(global: () => GlobalOpts): Command {
  return new Command("brief")
    .description("assembled startup brief")
    .option("--agent <agent>")
    .option("--project <project>")
    .option("--machine <machine>")
    .option("--cwd <cwd>")
    .option("--query <query>", "bias related-docs selection")
    .option("--format <format>", "markdown | json", "markdown")
    .action(
      async (opts: {
        agent?: string;
        project?: string;
        machine?: string;
        cwd?: string;
        query?: string;
        format?: string;
      }) => {
        const g = global();
        const wantJson = g.json || opts.format === "json";
        await withStore(g, async (store) => {
          const bo: BriefOptions = { format: wantJson ? "json" : "markdown" };
          if (opts.agent) bo.agent = opts.agent;
          if (opts.project) bo.project = opts.project;
          if (opts.machine) bo.machine = opts.machine;
          if (opts.cwd) bo.cwd = opts.cwd;
          if (opts.query) bo.query = opts.query;
          const brief = await store.brief(bo);
          if (wantJson) return printJson(brief);
          renderMarkdown(brief);
        });
      },
    );
}
