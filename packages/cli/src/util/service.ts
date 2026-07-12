/**
 * Service operations — the shell-out layer that materializes and manages a
 * chosen backend. Pure side-effects; the install *flow* (preflight, menus,
 * detection) lives in commands/install.ts and calls these.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderSystemdUnit,
  renderDockerRunArgs,
  systemdUnitPath,
  probeHealth,
  DOCKER_NAME,
  DEFAULT_PORT,
  SYSTEMD_UNIT,
  type ServiceScope,
  type InstallMethod,
  type UnitOptions,
} from "@grounded/core";

/** Default image ref. A local build tag; override with GROUNDED_IMAGE or --image
 *  to pull a published registry image (e.g. ghcr.io/<org>/grounded:latest). */
const IMAGE = process.env.GROUNDED_IMAGE || "grounded:latest";

/** A ref is registry-pullable if it names a host or namespace ("/" that isn't a
 *  bare local tag). Bare tags like "grounded:latest" are build-only. */
function isRemoteRef(ref: string): boolean {
  return ref.includes("/");
}

// ---- process helpers ---------------------------------------------------------

/** Run a command, streaming its output to the user's terminal. Resolves the exit code. */
export function stream(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Run a command and capture stdout (trimmed). Resolves null on failure. */
export function capture(cmd: string, args: string[], timeoutMs = 15000): Promise<string | null> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => res(err ? null : stdout.toString().trim()));
  });
}

// ---- systemctl scope helper --------------------------------------------------

function systemctl(scope: ServiceScope): { cmd: string; prefix: string[] } {
  if (scope === "user") return { cmd: "systemctl", prefix: ["--user"] };
  // system scope: use sudo when not already root
  const root = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  return root ? { cmd: "systemctl", prefix: [] } : { cmd: "sudo", prefix: ["systemctl"] };
}

// ---- grounded-api bin resolution (systemd path) ------------------------------

/** Locate the globally-installed grounded-api executable after `npm i -g`. */
export async function resolveApiBin(): Promise<string> {
  // Prefer the npm global bin dir (portable across nvm/volta/system node).
  const prefix = await capture("npm", ["prefix", "-g"]);
  if (prefix) {
    const binShim = join(prefix, "bin", "grounded-api");
    if (existsSync(binShim)) return binShim;
    const pkgBin = join(prefix, "lib", "node_modules", "@grounded", "api", "dist", "bin.js");
    if (existsSync(pkgBin)) return pkgBin;
  }
  // Fall back to PATH lookup; systemd will resolve it too.
  return "grounded-api";
}

// ---- docker build context ----------------------------------------------------

/** Find the Dockerfile/build context: env override, else the repo root above this package. */
export function dockerBuildContext(): string | null {
  const env = process.env.GROUNDED_BUILD_CONTEXT;
  if (env && existsSync(join(env, "Dockerfile"))) return env;
  // this file: packages/cli/dist/util/service.js → repo root is four levels up
  const here = dirname(fileURLToPath(import.meta.url));
  const guess = resolve(here, "..", "..", "..", "..");
  return existsSync(join(guess, "Dockerfile")) ? guess : null;
}

export async function dockerImageExists(image = IMAGE): Promise<boolean> {
  const out = await capture("docker", ["images", "-q", image]);
  return Boolean(out);
}

// ---- materialize -------------------------------------------------------------

export interface MaterializeOptions extends UnitOptions {
  port?: number;
}

/**
 * Ensure the image is available, in this order: use a locally-present image →
 * pull it (for registry refs) → build from source (when a context exists).
 * This lets a published registry image be used transparently while keeping the
 * zero-registry, build-from-source path working on a stranger's laptop.
 */
async function ensureImage(ref: string): Promise<void> {
  if (await dockerImageExists(ref)) return;

  if (isRemoteRef(ref)) {
    const pulled = await stream("docker", ["pull", ref]);
    if (pulled === 0) return;
    // fall through to build if a context is available
  }

  const ctx = dockerBuildContext();
  if (!ctx) {
    throw new Error(
      `image ${ref} not found${isRemoteRef(ref) ? " (and pull failed)" : ""} and no build ` +
        `context available. Set GROUNDED_BUILD_CONTEXT to the repo root, pre-build/pull the ` +
        `image, or set GROUNDED_IMAGE to a published ref.`,
    );
  }
  const code = await stream("docker", ["build", "-t", ref, ctx]);
  if (code !== 0) throw new Error(`docker build failed (exit ${code})`);
}

/** Docker: ensure image (local → pull → build), then run the labelled container. */
export async function materializeDocker(o: MaterializeOptions): Promise<void> {
  const ref = o.image ?? IMAGE;
  await ensureImage(ref);
  const code = await stream("docker", renderDockerRunArgs({ ...o, image: ref }));
  if (code !== 0) throw new Error(`docker run failed (exit ${code})`);
}

/** systemd: install grounded-api globally, write + enable the unit. */
export async function materializeSystemd(scope: ServiceScope, o: MaterializeOptions): Promise<void> {
  const npmCode = await stream("npm", ["install", "-g", "@grounded/api"]);
  if (npmCode !== 0) throw new Error(`npm i -g @grounded/api failed (exit ${npmCode})`);

  const execPath = await resolveApiBin();
  const unit = renderSystemdUnit(scope, { ...o, execPath });
  const path = systemdUnitPath(scope);

  if (scope === "user") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, unit, "utf8");
  } else {
    // system scope: write via a privileged tee since the path is root-owned
    await writeViaSudo(path, unit);
  }

  const { cmd, prefix } = systemctl(scope);
  const reload = await stream(cmd, [...prefix, "daemon-reload"]);
  if (reload !== 0) throw new Error(`systemctl daemon-reload failed (exit ${reload})`);
  const enable = await stream(cmd, [...prefix, "enable", "--now", SYSTEMD_UNIT]);
  if (enable !== 0) throw new Error(`systemctl enable --now failed (exit ${enable})`);
}

/** Write a root-owned file by piping content through `sudo tee`. */
function writeViaSudo(path: string, content: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("sudo", ["tee", path], { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res() : rej(new Error(`sudo tee ${path} failed`))));
    child.stdin.end(content);
  });
}

// ---- lifecycle ---------------------------------------------------------------

export async function startService(method: InstallMethod): Promise<number> {
  if (method === "docker") return stream("docker", ["start", DOCKER_NAME]);
  const scope: ServiceScope = method === "systemd-user" ? "user" : "system";
  const { cmd, prefix } = systemctl(scope);
  return stream(cmd, [...prefix, "start", SYSTEMD_UNIT]);
}

export async function stopService(method: InstallMethod): Promise<number> {
  if (method === "docker") return stream("docker", ["stop", DOCKER_NAME]);
  const scope: ServiceScope = method === "systemd-user" ? "user" : "system";
  const { cmd, prefix } = systemctl(scope);
  return stream(cmd, [...prefix, "stop", SYSTEMD_UNIT]);
}

export async function restartService(method: InstallMethod): Promise<number> {
  if (method === "docker") return stream("docker", ["restart", DOCKER_NAME]);
  const scope: ServiceScope = method === "systemd-user" ? "user" : "system";
  const { cmd, prefix } = systemctl(scope);
  return stream(cmd, [...prefix, "restart", SYSTEMD_UNIT]);
}

export async function logsService(method: InstallMethod, follow: boolean): Promise<number> {
  const tail = follow ? ["-f"] : ["-n", "200"];
  if (method === "docker") {
    return stream("docker", ["logs", ...(follow ? ["-f"] : ["--tail", "200"]), DOCKER_NAME]);
  }
  // journalctl gives readable service logs for both systemd scopes.
  if (method === "systemd-user") {
    return stream("journalctl", ["--user", "-u", SYSTEMD_UNIT, ...tail]);
  }
  return stream("sudo", ["journalctl", "-u", SYSTEMD_UNIT, ...tail]);
}

/** Tear down the chosen backend. Leaves the cabinet (data) untouched. */
export async function uninstallService(method: InstallMethod): Promise<void> {
  if (method === "docker") {
    await stream("docker", ["rm", "-f", DOCKER_NAME]);
    return;
  }
  const scope: ServiceScope = method === "systemd-user" ? "user" : "system";
  const { cmd, prefix } = systemctl(scope);
  await stream(cmd, [...prefix, "disable", "--now", SYSTEMD_UNIT]);
  const path = systemdUnitPath(scope);
  if (scope === "user") {
    await rm(path, { force: true });
  } else {
    await stream("sudo", ["rm", "-f", path]);
  }
  await stream(cmd, [...prefix, "daemon-reload"]);
}

// ---- health poll -------------------------------------------------------------

/** Poll /health until it comes up or the deadline passes. */
export async function healthPoll(port = DEFAULT_PORT, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await probeHealth(port, 1500);
    if (h) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
