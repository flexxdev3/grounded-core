import { Command } from "commander";
import type { RecallOptions, RecallResult, SourceType } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { withStore } from "../util/store.js";
import { c, line, printJson, header, truncate } from "../util/output.js";
import { parseInteger, parseList } from "../util/parse.js";

const VALID_SOURCES: SourceType[] = ["fact", "session", "doc"];

function matchedTag(m: RecallResult["matchedBy"]): string {
  if (m === "both") return c.magenta("both");
  if (m === "vector") return c.cyan("vec");
  return c.dim("lex");
}

function printCard(r: RecallResult): void {
  const id = c.bold(r.typedId);
  const score = c.dim(r.score.toFixed(3));
  line(`${id}  ${score}  ${matchedTag(r.matchedBy)}  ${truncate(r.title, 70)}`);
  if (r.snippet) line(`   ${c.dim(truncate(r.snippet, 96))}`);
  line(`   ${c.dim(r.citation)}`);
}

export function recallCommand(global: () => GlobalOpts): Command {
  return new Command("recall")
    .description("hybrid recall — compact, cited result cards")
    .argument("<query>", "search query")
    .option("--limit <n>", "max results", parseInteger)
    .option("--project <project>", "scope filter for facts/sessions")
    .option("--sources <a,b>", "restrict to fact,session,doc", parseList)
    .option("--lexical-only", "force lexical-only (skip embeddings)")
    .action(
      async (
        query: string,
        opts: { limit?: number; project?: string; sources?: string[]; lexicalOnly?: boolean },
      ) => {
        const g = global();
        await withStore(g, async (store) => {
          const ro: RecallOptions = {};
          if (opts.limit !== undefined) ro.limit = opts.limit;
          if (opts.project) ro.project = opts.project;
          if (opts.lexicalOnly) ro.lexicalOnly = true;
          if (opts.sources) {
            const sources = opts.sources.filter((s): s is SourceType =>
              (VALID_SOURCES as string[]).includes(s),
            );
            if (sources.length) ro.sources = sources;
          }
          const results = await store.recall(query, ro);
          if (g.json) return printJson(results);
          if (results.length === 0) return line(c.dim("no results"));
          header(`${results.length} result(s)`);
          for (const r of results) printCard(r);
        });
      },
    );
}
