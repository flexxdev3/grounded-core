import { Command } from "commander";
import {
  cabinetLayout,
  detect,
  migrateCabinet,
  planCabinetMigration,
  readManifest,
  resolveHome,
  CabinetMigrationError,
  DEFAULT_PORT,
  type InstallMethod,
} from "@grounded/core";
import type { GlobalOpts } from "../util/global.js";
import { c, line, header, field, printJson, fail } from "../util/output.js";
import { confirm, interactive } from "../util/prompt.js";
import { healthPoll, inspectDockerService, recreateDocker, startService, stopService } from "../util/service.js";

const MANAGEABLE: InstallMethod[] = ["docker", "systemd-user", "systemd-system", "windows-task"];

/**
 * Tell the operator when the cabinet is not where it should be. Printed by
 * `status` and `init`; silent for the normal layouts.
 */
export function printCabinetNotice(home: string): void {
  const layout = cabinetLayout(home);
  if (layout.kind === "legacy") {
    line();
    line(c.yellow(`your cabinet is in the legacy location ${layout.dir}`));
    line(c.dim(`  new installs keep data in ${layout.target}; it keeps working where it is.`));
    line(c.dim(`  to move it: ${c.cyan("grounded migrate-cabinet")} (stops the service, moves, verifies, restarts)`));
  } else if (layout.leftover) {
    line();
    line(c.yellow(`files remain in the old cabinet location ${layout.leftover}`));
    line(c.dim(`  the cabinet in use is ${layout.dir}. Merge or delete the old folder by hand.`));
  }
}

export function migrateCabinetCommand(global: () => GlobalOpts): Command {
  return new Command("migrate-cabinet")
    .description("move a legacy cabinet from ~/.grounded/cabinet to ~/Grounded/Cabinet (stops and restarts the service)")
    .option("-y, --yes", "no confirmation prompt")
    .action(async (opts: { yes?: boolean }) => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);

      let plan;
      try {
        plan = planCabinetMigration(home);
      } catch (err) {
        if (err instanceof CabinetMigrationError && err.code === "NOTHING_TO_MIGRATE") {
          if (g.json) return printJson({ migrated: false, reason: err.message });
          return line(c.dim(err.message));
        }
        return fail((err as Error).message);
      }

      const manifest = readManifest(home);
      const d = await detect({ home });
      let method = (MANAGEABLE as string[]).includes(String(d.method)) ? (d.method as InstallMethod) : undefined;
      // Read the container's image + token BEFORE stopping it: a Docker install
      // has to be recreated, because its old mount points at the old folder.
      // A container that does not mount THIS home is someone else's: never touch it.
      const container = method === "docker" ? await inspectDockerService() : null;
      if (method === "docker" && !container?.mounts.some((m) => m === home)) method = undefined;
      if (d.running && !method) {
        return fail(
          "an instance is serving that `grounded` did not install, so it cannot be stopped from here. " +
            "Stop it, then re-run `grounded migrate-cabinet`.",
        );
      }
      const port = d.health?.port ?? manifest?.port ?? DEFAULT_PORT;

      if (!g.json) {
        header("Move the cabinet");
        field("from", plan.from);
        field("to", plan.to);
        if (method) field("service", `${method}${d.running ? " (will be stopped and restarted)" : ""}`);
        line();
      }
      if (!opts.yes && interactive && !(await confirm("Proceed?", true))) return line(c.dim("aborted."));

      if (method && d.running) {
        const code = await stopService(method, home);
        if (code !== 0) return fail(`could not stop the ${method} service (exit ${code}); nothing was moved.`);
      }

      let result;
      try {
        result = await migrateCabinet(home);
      } catch (err) {
        if (method && d.running) await startService(method, home);
        return fail(`${(err as Error).message}${method && d.running ? " (service restarted on the old cabinet)" : ""}`);
      }

      if (method === "docker" && container) {
        try {
          await recreateDocker({ home, port, image: container.image, token: container.token });
        } catch (err) {
          return fail(
            `cabinet moved to ${result.to}, but the container could not be recreated: ${(err as Error).message}. ` +
              "Run `grounded install --method docker` to finish.",
          );
        }
      } else if (method && d.running) {
        const code = await startService(method, home);
        if (code !== 0) return fail(`cabinet moved to ${result.to}, but the service did not start (exit ${code}).`);
      }
      const healthy = method && (d.running || method === "docker") ? await healthPoll(port) : undefined;

      if (g.json) return printJson({ migrated: true, ...result, method, healthy });
      line(c.green(`moved ${result.files} file${result.files === 1 ? "" : "s"} (${result.bytes} bytes) by ${result.method} to ${result.to}`));
      if (healthy === false) line(c.yellow(`service is not healthy on :${port} yet; check ${c.cyan("grounded logs")}.`));
      else if (healthy) line(c.green(`service healthy on :${port}`));
    });
}
