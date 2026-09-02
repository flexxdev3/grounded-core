import { Command } from "commander";
import {
  bootstrap,
  detect,
  writeManifest,
  installSnippet,
  resolveHome,
  DEFAULT_PORT,
  type InstallMethod,
  type InstallManifest,
} from "@grounded/core";
import type { GlobalOpts } from "../util/global.js";
import { c, line, header, field, fail } from "../util/output.js";
import { select, confirm, interactive, type Choice } from "../util/prompt.js";
import { detectCapabilities } from "../util/preflight.js";
import { materializeDocker, materializeSystemd, healthPoll } from "../util/service.js";

interface InstallOpts {
  port?: string;
  method?: string;
  token?: string;
  image?: string;
  yes?: boolean;
  force?: boolean;
}

const METHOD_LABEL: Record<InstallMethod, string> = {
  docker: "Docker container",
  "systemd-user": "systemd service (user)",
  "systemd-system": "systemd service (system)",
};

export function installCommand(global: () => GlobalOpts): Command {
  return new Command("install")
    .description("stand Grounded up as a persistent service (Docker or systemd)")
    .option("--port <n>", `listen port (default ${DEFAULT_PORT})`)
    .option("--method <m>", "skip the menu: docker | systemd-user | systemd-system")
    .option("--image <ref>", "docker only: image ref to run (pulled if remote; else built from source)")
    .option("--token <tok>", "require this bearer token for the API")
    .option("-y, --yes", "accept defaults, no prompts")
    .option("--force", "install even if an instance is already detected")
    .action(async (opts: InstallOpts) => {
      const g = global();
      const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
      const port = opts.port ? Number(opts.port) : DEFAULT_PORT;
      if (!Number.isInteger(port) || port <= 0) return fail(`invalid --port ${opts.port}`);

      // 1. Guard: is Grounded already running? Never double-install.
      const existing = await detect({ home, port });
      if (existing.running && !opts.force) {
        header("Grounded is already running");
        for (const e of existing.evidence) field(e.kind, e.detail);
        line();
        line(
          `An instance is live${existing.method ? ` via ${c.bold(String(existing.method))}` : ""}. ` +
            `Manage it with ${c.cyan("grounded status / restart / uninstall")},`,
        );
        line(`or re-run with ${c.cyan("--force")} to install anyway (not recommended — risks two writers on one cabinet).`);
        return;
      }

      // 2. Preflight: which methods can this host actually do?
      const caps = await detectCapabilities();
      const choices: Choice<InstallMethod>[] = [
        {
          value: "docker",
          label: METHOD_LABEL.docker,
          hint: "isolated, restart=unless-stopped",
          disabled: caps.docker.daemon ? undefined : caps.docker.detail,
        },
        {
          value: "systemd-user",
          label: METHOD_LABEL["systemd-user"],
          hint: "no root, runs as you (enable-linger to survive logout)",
          disabled: caps.systemd.user ? undefined : "no systemd user manager",
        },
        {
          value: "systemd-system",
          label: METHOD_LABEL["systemd-system"],
          hint: "always-on, needs root/sudo",
          disabled: caps.systemd.system ? undefined : "needs root or passwordless sudo",
        },
      ];
      const available = choices.filter((ch) => !ch.disabled);
      if (available.length === 0) {
        return fail(
          "no install method available: Docker daemon not reachable and systemd not usable. " +
            "Start Docker, or install on a systemd host.",
        );
      }

      // Default: Docker when its daemon is up, else the first available method.
      const rawDefaultIdx = caps.docker.daemon
        ? choices.findIndex((ch) => ch.value === "docker")
        : choices.findIndex((ch) => !ch.disabled);
      const defaultIdx = rawDefaultIdx >= 0 ? rawDefaultIdx : choices.indexOf(available[0]!);
      const defaultChoice = choices[defaultIdx] ?? available[0]!;

      // 3. Choose method (flag > menu > single-available auto).
      let method: InstallMethod;
      if (opts.method) {
        if (!["docker", "systemd-user", "systemd-system"].includes(opts.method)) {
          return fail(`--method must be docker | systemd-user | systemd-system`);
        }
        method = opts.method as InstallMethod;
        const chosen = choices.find((ch) => ch.value === method);
        if (chosen?.disabled) return fail(`${METHOD_LABEL[method]} unavailable: ${chosen.disabled}`);
      } else if (opts.yes || !interactive) {
        method = defaultChoice.value;
        line(c.dim(`selected ${METHOD_LABEL[method]} (default)`));
      } else {
        method = await select("How should Grounded run?", choices, defaultIdx);
      }

      // 4. --image is a Docker-only concept. systemd installs the npm-published
      // grounded-api and runs it directly — there is no container and no image
      // ref to honour, so threading the flag through would be meaningless. An
      // accepted-and-ignored flag is the same silent lie as a bare image tag
      // that can never be pulled: reject it and name the two ways forward.
      if (opts.image && method !== "docker") {
        return fail(
          `--image applies only to --method docker; ${METHOD_LABEL[method]} does not run a ` +
            `container image.\n` +
            `  ${METHOD_LABEL[method]} installs the published @grounded/api package and runs it\n` +
            `  directly, so there is nothing for "${opts.image}" to apply to.\n\n` +
            `  do one of:\n` +
            `    1. install the image in a container:  grounded install --method docker --image ${opts.image}\n` +
            `    2. keep this method and drop the flag: grounded install --method ${method}`,
        );
      }

      // 5. Confirm.
      line();
      field("method", METHOD_LABEL[method]);
      field("cabinet", home);
      field("port", String(port));
      if (opts.token) field("auth", "bearer token");
      line();
      if (!opts.yes && interactive && !(await confirm("Proceed with install?", true))) {
        return line(c.dim("aborted."));
      }

      // 6. Bootstrap the cabinet (dirs + config + migrations). Idempotent.
      line(c.dim("• preparing cabinet…"));
      try {
        const b = await bootstrap({ home });
        line(c.dim(`  ${b.wroteConfig ? "wrote" : "found"} ${b.configPath}`));
      } catch (err) {
        return fail(`bootstrap failed: ${(err as Error).message}`);
      }

      // 7. Materialize the chosen backend.
      line(c.dim(`• installing via ${METHOD_LABEL[method]}…`));
      try {
        if (method === "docker") {
          await materializeDocker({ home, port, token: opts.token, image: opts.image });
        } else {
          const scope = method === "systemd-user" ? "user" : "system";
          await materializeSystemd(scope, { home, port, token: opts.token });
        }
      } catch (err) {
        return fail((err as Error).message);
      }

      // 8. Wait for health.
      line(c.dim("• waiting for the service to come up…"));
      const healthy = await healthPoll(port);
      if (!healthy) {
        return fail(
          `service did not become healthy on :${port} within 30s. ` +
            `Check logs with ${c.cyan("grounded logs")}.`,
        );
      }

      // 9. Record the source of truth for future re-runs.
      const manifest: InstallManifest = {
        method,
        port,
        version: "0.1.0",
        installedAt: new Date().toISOString(),
      };
      try {
        writeManifest(manifest, home);
      } catch {
        /* non-fatal: detection still works via health/label/unit probes */
      }

      // 10. Done — point the user at the console + agent wiring.
      line();
      header("Grounded is live ✓");
      field("console", `http://127.0.0.1:${port}/`);
      field("health", `http://127.0.0.1:${port}/health`);
      line();
      line(`Wire an agent over MCP:  ${c.cyan("grounded mcp install")}`);
      line(`Manage the service:      ${c.cyan("grounded status | restart | logs | uninstall")}`);
      if (!opts.token) {
        line(c.dim(`\nTip: the API is unauthenticated on loopback. Add ${c.cyan("--token")} to require a bearer token.`));
      }
      // Nudge the primary MCP wiring inline.
      line();
      const snip = installSnippet("claude-code");
      line(c.dim(`— paste into ${snip.file} to connect Claude Code —`));
      line(snip.snippet);
    });
}
