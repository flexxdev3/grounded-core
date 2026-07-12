import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GlobalOpts } from "../util/global.js";
import { c, line, printJson, header, field, fail } from "../util/output.js";

type HookTarget = "claude-code" | "codex" | "cursor" | "generic";
const HOOK_TARGETS: HookTarget[] = ["claude-code", "codex", "cursor", "generic"];

// hooks/ ships alongside dist/ (see package.json "files"); from dist/commands/ → ../../hooks
const hooksDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

function scriptName(target: HookTarget): string {
  return target === "claude-code"
    ? "grounded-session-start.sh"
    : "grounded-session-start.generic.sh";
}

function assertTarget(value: string): HookTarget {
  if ((HOOK_TARGETS as string[]).includes(value)) return value as HookTarget;
  fail(`unknown target "${value}" (expected: ${HOOK_TARGETS.join(", ")})`);
}

function wiring(target: HookTarget, absScript: string): string {
  if (target === "claude-code") {
    const snippet = JSON.stringify(
      { hooks: { SessionStart: [{ hooks: [{ type: "command", command: absScript }] }] } },
      null,
      2,
    );
    return `Wire into ~/.claude/settings.json (merge under "hooks"):\n${snippet}`;
  }
  // codex / cursor / generic have no standard SessionStart shell hook; the script
  // prints the brief to stdout — invoke it from your startup mechanism.
  return [
    "This script prints the brief to stdout. Invoke it from your runtime's",
    "startup/pre-session command, or run it manually:",
    `  ${absScript} "$PWD"`,
    "It fetches from the running service ($GROUNDED_URL, default",
    "http://127.0.0.1:7437) — or hit POST /brief directly when you need context.",
  ].join("\n");
}

export function hooksCommand(global: () => GlobalOpts): Command {
  const cmd = new Command("hooks").description("SessionStart brief wrappers for agents");

  cmd
    .command("print")
    .description("print a SessionStart hook script + wiring (does not modify files)")
    .argument("[target]", `one of: ${HOOK_TARGETS.join(", ")} (default: claude-code)`)
    .action((target: string | undefined) => {
      const g = global();
      const t = target ? assertTarget(target) : "claude-code";
      const abs = join(hooksDir, scriptName(t));
      let script: string;
      try {
        script = readFileSync(abs, "utf8");
      } catch {
        fail(`could not read hook script at ${abs}`);
      }
      if (g.json) return printJson({ target: t, path: abs, script, wiring: wiring(t, abs) });
      header(`${t} SessionStart hook`);
      field("script", abs);
      line();
      line(script);
      line(c.dim(wiring(t, abs)));
    });

  cmd
    .command("targets")
    .description("list available hook targets")
    .action(() => {
      const g = global();
      if (g.json) return printJson(HOOK_TARGETS);
      for (const t of HOOK_TARGETS) line(t);
    });

  return cmd;
}
