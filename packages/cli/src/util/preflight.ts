/**
 * Preflight — capability probes that decide which install methods are offered.
 *
 * Every probe is best-effort and quick; a probe never throws. The installer
 * uses these to build the *dynamic* menu (only offer what the host can do) and
 * to warn about blockers (port in use, no privilege for a system unit).
 */
import { execFile } from "node:child_process";
import { createConnection } from "node:net";

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout ?? "").toString().trim() });
    });
  });
}

export interface Capabilities {
  docker: { present: boolean; daemon: boolean; detail: string };
  systemd: { present: boolean; user: boolean; system: boolean; detail: string };
  npm: { present: boolean; version: string };
  node: { version: string };
  root: boolean;
  sudo: boolean;
}

/** Docker usable = CLI present AND daemon reachable (`docker info`). */
export async function probeDocker(): Promise<Capabilities["docker"]> {
  const v = await run("docker", ["--version"]);
  if (!v.ok) return { present: false, daemon: false, detail: "docker CLI not found" };
  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 8000);
  return {
    present: true,
    daemon: info.ok,
    detail: info.ok ? `daemon ${info.out}` : "docker installed but daemon not reachable",
  };
}

/** systemd usable = systemctl present; separately probe user + system managers. */
export async function probeSystemd(root: boolean): Promise<Capabilities["systemd"]> {
  const v = await run("systemctl", ["--version"]);
  if (!v.ok) return { present: false, user: false, system: false, detail: "systemctl not found" };
  // user manager present if `systemctl --user` responds (has a running user bus)
  const user = await run("systemctl", ["--user", "is-system-running"]);
  const userOk = user.ok || /(running|degraded|starting)/.test(user.out);
  // system scope is installable if we are root or have passwordless sudo (checked by caller)
  const firstLine = v.out.split("\n")[0] ?? "systemd";
  return {
    present: true,
    user: userOk,
    system: root, // refined by caller with sudo info
    detail: firstLine,
  };
}

export async function probeNpm(): Promise<Capabilities["npm"]> {
  const v = await run("npm", ["--version"]);
  return { present: v.ok, version: v.ok ? v.out : "" };
}

/** Passwordless sudo available? (`sudo -n true`) — best-effort, never blocks. */
export async function probeSudo(): Promise<boolean> {
  const v = await run("sudo", ["-n", "true"], 3000);
  return v.ok;
}

/** Is a TCP listener already accepting on the port? true = occupied. */
export function portInUse(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false)); // ECONNREFUSED = nothing listening
  });
}

/** Gather all host capabilities in parallel. */
export async function detectCapabilities(): Promise<Capabilities> {
  const root = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  const [docker, systemdRaw, npm, sudo] = await Promise.all([
    probeDocker(),
    probeSystemd(root),
    probeNpm(),
    probeSudo(),
  ]);
  const systemd = { ...systemdRaw, system: systemdRaw.present && (root || sudo) };
  return { docker, systemd, npm, node: { version: process.version }, root, sudo };
}
