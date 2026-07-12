import { Command } from "commander";
import {
  detect,
  readManifest,
  resolveHome,
  manifestPath,
  DEFAULT_PORT,
  type InstallMethod,
} from "@grounded/core";
import { rm } from "node:fs/promises";
import type { GlobalOpts } from "../util/global.js";
import { c, line, header, field, printJson, fail, ok } from "../util/output.js";
import { confirm, interactive } from "../util/prompt.js";
import {
  startService,
  stopService,
  restartService,
  logsService,
  uninstallService,
} from "../util/service.js";

const MANAGEABLE: InstallMethod[] = ["docker", "systemd-user", "systemd-system"];

function isManageable(m: unknown): m is InstallMethod {
  return typeof m === "string" && (MANAGEABLE as string[]).includes(m);
}

async function resolveMethod(home: string, port: number): Promise<InstallMethod> {
  const d = await detect({ home, port });
  if (isManageable(d.method)) return d.method;
  if (d.running) {
    fail(
      "an instance is serving but was not installed by `grounded` (no recognized backend). " +
        "Manage it with whatever started it, or stop it and run `grounded install`.",
    );
  }
  fail("no Grounded service found. Run `grounded install` first.");
}

// ---- status ------------------------------------------------------------------

export function statusCommand(global: () => GlobalOpts): Command {
  return new Command("status")
    .description("show whether Grounded is running, how, and its health")
    .option("--port <n>", `port to probe (default ${DEFAULT_PORT})`)
    .action(async (opts: { port?: string }) => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
      const port = opts.port ? Number(opts.port) : undefined;
      const d = await detect({ home, port });

      if (g.json) return printJson(d);

      header("Grounded status");
      field("running", d.running ? c.green("yes") : c.red("no"));
      if (d.method) field("method", String(d.method));
      field("cabinet", home);
      if (d.health) {
        field("health", ok(d.health.ok));
        field("port", String(d.health.port));
        field("adapter", d.health.adapter ?? "—");
        if (d.health.counts) {
          field(
            "counts",
            `${d.health.counts.facts} facts · ${d.health.counts.sessions} sessions · ${d.health.counts.documents} docs`,
          );
        }
      }
      if (d.evidence.length) {
        line();
        line(c.dim("evidence:"));
        for (const e of d.evidence) field(`  ${e.kind}`, e.detail);
      }
      if (!d.running) {
        line();
        line(c.dim("not running — `grounded install` to set it up."));
      }
    });
}

// ---- start / stop / restart --------------------------------------------------

export function startCommand(global: () => GlobalOpts): Command {
  return new Command("start")
    .description("start the Grounded service")
    .action(async () => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
      const method = await resolveMethod(home, DEFAULT_PORT);
      const code = await startService(method);
      if (code !== 0) return fail(`start failed (exit ${code})`);
      line(c.green(`started (${method})`));
    });
}

export function stopCommand(global: () => GlobalOpts): Command {
  return new Command("stop")
    .description("stop the Grounded service")
    .action(async () => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
      const method = await resolveMethod(home, DEFAULT_PORT);
      const code = await stopService(method);
      if (code !== 0) return fail(`stop failed (exit ${code})`);
      line(c.green(`stopped (${method})`));
    });
}

export function restartCommand(global: () => GlobalOpts): Command {
  return new Command("restart")
    .description("restart the Grounded service")
    .action(async () => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
      const method = await resolveMethod(home, DEFAULT_PORT);
      const code = await restartService(method);
      if (code !== 0) return fail(`restart failed (exit ${code})`);
      line(c.green(`restarted (${method})`));
    });
}

// ---- logs --------------------------------------------------------------------

export function logsCommand(global: () => GlobalOpts): Command {
  return new Command("logs")
    .description("show service logs")
    .option("-f, --follow", "stream logs")
    .action(async (opts: { follow?: boolean }) => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
      const method = await resolveMethod(home, DEFAULT_PORT);
      await logsService(method, Boolean(opts.follow));
    });
}

// ---- uninstall ---------------------------------------------------------------

export function uninstallCommand(global: () => GlobalOpts): Command {
  return new Command("uninstall")
    .description("remove the service (keeps the cabinet/data by default)")
    .option("--purge", "also delete the cabinet (~/.grounded) — destroys all data")
    .option("-y, --yes", "no confirmation prompt")
    .action(async (opts: { purge?: boolean; yes?: boolean }) => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
      const manifest = readManifest(home);
      const d = await detect({ home });
      const method = isManageable(d.method) ? d.method : manifest?.method;
      if (!method) return fail("no Grounded service found to uninstall.");

      line(`This will remove the ${c.bold(method)} service.`);
      if (opts.purge) line(c.red(`--purge will DELETE the cabinet at ${home} (all facts, sessions, docs).`));
      if (!opts.yes && interactive && !(await confirm("Continue?", false))) {
        return line(c.dim("aborted."));
      }

      try {
        await uninstallService(method);
      } catch (err) {
        return fail(`uninstall failed: ${(err as Error).message}`);
      }
      // Drop the manifest; optionally purge data.
      await rm(manifestPath(home), { force: true });
      if (opts.purge) {
        await rm(home, { recursive: true, force: true });
        line(c.yellow(`purged ${home}`));
      }
      line(c.green(`uninstalled (${method})${opts.purge ? " + purged cabinet" : " — cabinet kept"}`));
    });
}
