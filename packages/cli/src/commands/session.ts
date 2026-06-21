import { Command } from "commander";
import type { ListOptions, Session, SessionInput, TimelineOptions } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { withStore } from "../util/store.js";
import { c, line, printJson, header, truncate } from "../util/output.js";
import { parseInteger, parseList } from "../util/parse.js";

function printSession(s: Session): void {
  const meta = c.dim(
    `session:${s.id} · ${s.createdAt}${s.project ? ` · ${s.project}` : ""}${
      s.agent ? ` · ${s.agent}` : ""
    }${s.machine ? ` · ${s.machine}` : ""}`,
  );
  line(s.summary);
  line(`  ${meta}`);
  if (s.tags && s.tags.length) line(`  ${c.cyan(s.tags.join(", "))}`);
  if (s.details) line(`  ${c.dim(truncate(s.details, 100))}`);
}

interface AddOpts {
  project?: string;
  agent?: string;
  machine?: string;
  details?: string;
  workspace?: string;
  tags?: string[];
}

export function sessionCommand(global: () => GlobalOpts): Command {
  const cmd = new Command("session").description("chronological work-log entries");

  cmd
    .command("add")
    .description("log a session")
    .argument("<summary>", "one-line summary")
    .option("--project <project>")
    .option("--agent <agent>")
    .option("--machine <machine>")
    .option("--workspace <workspace>")
    .option("--details <details>", "longer body")
    .option("--tags <a,b>", "comma-separated tags", parseList)
    .action(async (summary: string, opts: AddOpts) => {
      const g = global();
      await withStore(g, async (store) => {
        const input: SessionInput = { summary };
        if (opts.project) input.project = opts.project;
        if (opts.agent) input.agent = opts.agent;
        if (opts.machine) input.machine = opts.machine;
        if (opts.workspace) input.workspace = opts.workspace;
        if (opts.details) input.details = opts.details;
        if (opts.tags) input.tags = opts.tags;
        const s = await store.sessionsAdd(input);
        if (g.json) return printJson(s);
        line(c.green(`added session:${s.id}`));
        printSession(s);
      });
    });

  cmd
    .command("list")
    .description("list recent sessions")
    .option("--project <project>", "filter by project")
    .option("--limit <n>", "max results", parseInteger)
    .action(async (opts: { project?: string; limit?: number }) => {
      const g = global();
      await withStore(g, async (store) => {
        const lo: ListOptions = {};
        if (opts.project) lo.project = opts.project;
        if (opts.limit !== undefined) lo.limit = opts.limit;
        const sessions = await store.sessionsList(lo);
        if (g.json) return printJson(sessions);
        if (sessions.length === 0) return line(c.dim("no sessions"));
        header(`${sessions.length} session(s)`);
        for (const s of sessions) printSession(s);
      });
    });

  cmd
    .command("timeline")
    .description("show sessions around an anchor or query")
    .option("--around <id>", "anchor session id", parseInteger)
    .option("--query <q>", "anchor by query")
    .option("--project <project>")
    .option("--window <n>", "entries before/after the anchor", parseInteger)
    .action(async (opts: { around?: number; query?: string; project?: string; window?: number }) => {
      const g = global();
      await withStore(g, async (store) => {
        const to: TimelineOptions = {};
        if (opts.around !== undefined) to.around = opts.around;
        if (opts.query) to.query = opts.query;
        if (opts.project) to.project = opts.project;
        if (opts.window !== undefined) to.window = opts.window;
        const sessions = await store.sessionsTimeline(to);
        if (g.json) return printJson(sessions);
        if (sessions.length === 0) return line(c.dim("no sessions"));
        header(`timeline (${sessions.length})`);
        for (const s of sessions) printSession(s);
      });
    });

  return cmd;
}
