import { Command } from "commander";
import { installSnippet, INSTALL_TARGETS } from "@grounded/core";
import type { InstallTarget, InstallSnippet } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { c, line, printJson, header, field, fail } from "../util/output.js";
import { parseEnvPair } from "../util/parse.js";

function assertTarget(value: string): InstallTarget {
  if ((INSTALL_TARGETS as string[]).includes(value)) return value as InstallTarget;
  fail(`unknown target "${value}" (expected: ${INSTALL_TARGETS.join(", ")})`);
}

function renderSnippet(s: InstallSnippet): void {
  header(`${s.label}  ${c.dim(`(${s.target})`)}`);
  field("paste into", s.file);
  line();
  line(s.snippet);
  line(c.dim(`\nthen restart ${s.label} — the grounded-mcp server will be available.\n`));
}

export function mcpCommand(global: () => GlobalOpts): Command {
  const cmd = new Command("mcp").description("wire Grounded into agents over MCP");

  cmd
    .command("install")
    .description("print a ready-to-paste MCP server config (does not modify files)")
    .argument("[target]", `one of: ${INSTALL_TARGETS.join(", ")} (default: all)`)
    .option("--env <KEY=VAL>", "inject an env var into the snippet (repeatable)", parseEnvPair, {})
    .option("--all", "print every target")
    .action((target: string | undefined, opts: { env: Record<string, string>; all?: boolean }) => {
      const g = global();
      const env = Object.keys(opts.env).length ? opts.env : undefined;
      const targets: InstallTarget[] =
        !target || opts.all ? INSTALL_TARGETS : [assertTarget(target)];
      const snippets = targets.map((t) => installSnippet(t, env));
      if (g.json) return printJson(snippets);
      snippets.forEach(renderSnippet);
    });

  cmd
    .command("targets")
    .description("list available install targets")
    .action(() => {
      const g = global();
      if (g.json) return printJson(INSTALL_TARGETS);
      for (const t of INSTALL_TARGETS) line(t);
    });

  return cmd;
}
