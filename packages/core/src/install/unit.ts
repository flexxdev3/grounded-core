/**
 * Service-unit rendering — one config, two backends.
 *
 * The installer picks Docker or systemd; both must run the *same* grounded-api
 * against the *same* cabinet on the *same* port. This module renders the
 * concrete artifacts so nothing is hand-maintained:
 *   - systemd:  a `grounded.service` unit (user or system scope) that runs the
 *               globally-installed `grounded-api` bin.
 *   - docker:   the `docker run` argv (and a compose file) that mounts the
 *               cabinet and labels the container for detection.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, DOCKER_NAME, DOCKER_LABEL, SYSTEMD_UNIT } from "./detect.js";

export type ServiceScope = "user" | "system";

export interface UnitOptions {
  /** cabinet root mounted/served; defaults to ~/.grounded. */
  home?: string;
  /** listen port; defaults to 7437. */
  port?: number;
  /** bind host. systemd defaults 127.0.0.1; docker publishes on 127.0.0.1 too. */
  host?: string;
  /** absolute path to the grounded-api bin (systemd). Resolved by the installer. */
  execPath?: string;
  /** docker image ref for the container backend. */
  image?: string;
  /** optional bearer token (GROUNDED_API_TOKEN). */
  token?: string;
}

function homeOf(o: UnitOptions): string {
  return o.home ?? join(homedir(), ".grounded");
}

/** Where the unit file is written for a given scope. User units live under the
 *  user's XDG config dir (independent of the cabinet); system units under /etc. */
export function systemdUnitPath(scope: ServiceScope): string {
  if (scope === "user") {
    const cfgBase = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(cfgBase, "systemd", "user", SYSTEMD_UNIT);
  }
  return join("/etc/systemd/system", SYSTEMD_UNIT);
}

/**
 * Render a systemd unit. The systemd backend runs the npm-global `grounded-api`
 * bin directly (decision: no Docker dependency on this path), so `execPath`
 * should point at the resolved bin (e.g. `$(npm root -g)/@grounded/api/dist/bin.js`
 * or the `grounded-api` shim on PATH).
 */
export function renderSystemdUnit(scope: ServiceScope, o: UnitOptions = {}): string {
  const home = homeOf(o);
  const port = o.port ?? DEFAULT_PORT;
  const host = o.host ?? "127.0.0.1";
  const exec = o.execPath ?? "grounded-api";
  const env: string[] = [
    `Environment=GROUNDED_HOME=${home}`,
    `Environment=GROUNDED_API_HOST=${host}`,
    `Environment=GROUNDED_API_PORT=${port}`,
    `Environment=GROUNDED_API_UI=1`,
  ];
  if (o.token) env.push(`Environment=GROUNDED_API_TOKEN=${o.token}`);

  const lines = [
    `[Unit]`,
    `Description=Grounded — self-hosted continuity API + console`,
    `Documentation=https://github.com/grounded`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    ...env,
    `ExecStart=${exec}`,
    `Restart=always`,
    `RestartSec=3`,
    scope === "system" ? `# runs as root unless a User= is set` : `# runs as the invoking user`,
    ``,
    `[Install]`,
    scope === "user" ? `WantedBy=default.target` : `WantedBy=multi-user.target`,
    ``,
  ];
  return lines.join("\n");
}

/** `docker run` argv for the container backend (detached, restart, labelled, cabinet-mounted). */
export function renderDockerRunArgs(o: UnitOptions = {}): string[] {
  const home = homeOf(o);
  const port = o.port ?? DEFAULT_PORT;
  const image = o.image ?? "grounded:latest";
  const args = [
    "run",
    "-d",
    "--name",
    DOCKER_NAME,
    "--restart",
    "unless-stopped",
    "--label",
    `${DOCKER_LABEL}=true`,
    "-p",
    // publish on loopback only by default; the container listens on 0.0.0.0 internally
    `127.0.0.1:${port}:${port}`,
    "-e",
    `GROUNDED_API_PORT=${port}`,
    "-v",
    `${home}:/cabinet`,
  ];
  if (o.token) args.push("-e", `GROUNDED_API_TOKEN=${o.token}`);
  args.push(image);
  return args;
}

/** A minimal compose file mirroring the `docker run` args, for users who prefer it. */
export function renderComposeYaml(o: UnitOptions = {}): string {
  const home = homeOf(o);
  const port = o.port ?? DEFAULT_PORT;
  const image = o.image ?? "grounded:latest";
  const tokenLine = o.token ? `      GROUNDED_API_TOKEN: ${o.token}\n` : "";
  return (
    `services:\n` +
    `  grounded:\n` +
    `    image: ${image}\n` +
    `    container_name: ${DOCKER_NAME}\n` +
    `    restart: unless-stopped\n` +
    `    labels:\n` +
    `      ${DOCKER_LABEL}: "true"\n` +
    `    ports:\n` +
    `      - "127.0.0.1:${port}:${port}"\n` +
    `    environment:\n` +
    `      GROUNDED_API_PORT: ${port}\n` +
    tokenLine +
    `    volumes:\n` +
    `      - ${home}:/cabinet\n`
  );
}
