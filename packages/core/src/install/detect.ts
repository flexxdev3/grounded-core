/**
 * Instance detection — the anti-double-install guard.
 *
 * A Grounded instance can be stood up three ways (Docker, systemd --user,
 * systemd --system) and even as a bare `grounded-api` process. Before the
 * installer materializes anything it must know whether one is *already*
 * serving — otherwise two writers race on the same sqlite file (corruption)
 * and two listeners fight over the port.
 *
 * Detection is layered and every probe is best-effort (never throws):
 *   1. Health probe on the port  → authoritative that *something* Grounded serves.
 *   2. Docker label / systemctl is-active → *which* method, so we can manage it.
 *   3. install.json manifest      → the recorded source of truth for re-runs.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolveHome } from "./bootstrap.js";

export const DEFAULT_PORT = 7437;
/** Container name + label the Docker backend stamps, so detection can find it. */
export const DOCKER_NAME = "grounded";
export const DOCKER_LABEL = "com.grounded.managed";
/** systemd unit name for both user and system scope. */
export const SYSTEMD_UNIT = "grounded.service";

export type InstallMethod = "docker" | "systemd-user" | "systemd-system";

/** ~/.grounded/install.json — the recorded source of truth for how it was installed. */
export interface InstallManifest {
  method: InstallMethod;
  port: number;
  /** container id (docker) or unit name (systemd). */
  ref?: string;
  version?: string;
  /** ISO timestamp; set by the caller (avoids a clock dep in core). */
  installedAt?: string;
}

/** Positive fingerprint of a Grounded /health response. */
export interface HealthProbe {
  ok: boolean;
  port: number;
  adapter?: string;
  provider?: string;
  counts?: { facts: number; sessions: number; docs: number; documents: number };
}

export interface Evidence {
  kind: "health" | "docker" | "systemd-user" | "systemd-system" | "manifest";
  detail: string;
}

export interface DetectResult {
  /** true if the health probe confirmed a live Grounded on the port. */
  running: boolean;
  /** best guess of how it is running, from manifest or unit/container evidence. */
  method?: InstallMethod | "process";
  health?: HealthProbe;
  manifest?: InstallManifest;
  /** everything found, for a transparent "already installed via X" message. */
  evidence: Evidence[];
}

const MANIFEST_FILE = "install.json";

// ---- manifest ----------------------------------------------------------------

export function manifestPath(home?: string): string {
  return join(resolveHome(home), MANIFEST_FILE);
}

export function readManifest(home?: string): InstallManifest | undefined {
  const path = manifestPath(home);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as InstallManifest;
  } catch {
    return undefined;
  }
}

export function writeManifest(manifest: InstallManifest, home?: string): void {
  writeFileSync(manifestPath(home), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// ---- probes ------------------------------------------------------------------

/** Run a command with a hard timeout; resolve stdout or null on any failure. */
function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });
}

/** GET /health and confirm the response is actually Grounded's shape. */
export async function probeHealth(port = DEFAULT_PORT, timeoutMs = 2500): Promise<HealthProbe | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!isGroundedHealth(body)) return null;
    return {
      ok: Boolean(body.ok),
      port,
      adapter: body.storage?.adapter,
      provider: body.embeddings?.provider,
      counts: body.counts,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface RawHealth {
  ok?: unknown;
  storage?: { adapter?: string };
  embeddings?: { provider?: string; dims?: unknown };
  counts?: { facts: number; sessions: number; docs: number; documents: number };
}

/** The discriminator: storage.adapter + embeddings.dims + counts.documents together
 *  only appear on a Grounded /health, not on some other service squatting the port. */
function isGroundedHealth(v: unknown): v is RawHealth {
  if (typeof v !== "object" || v === null) return false;
  const o = v as RawHealth;
  return (
    typeof o.storage?.adapter === "string" &&
    typeof o.embeddings?.dims !== "undefined" &&
    typeof o.counts?.documents === "number"
  );
}

/** Look for a running container the Docker backend labelled as ours. */
export async function detectDocker(): Promise<{ id: string; status: string } | null> {
  const out = await run("docker", [
    "ps",
    "--filter",
    `label=${DOCKER_LABEL}=true`,
    "--format",
    "{{.ID}}\t{{.Status}}",
  ]);
  if (!out) return null;
  const line = out.trim().split("\n").filter(Boolean)[0];
  if (!line) return null;
  const [id, ...rest] = line.split("\t");
  if (!id) return null;
  return { id, status: rest.join(" ") };
}

/** `systemctl [--user] is-active grounded` → active/inactive/failed/unknown. */
export async function detectSystemd(scope: "user" | "system"): Promise<string | null> {
  const args = scope === "user" ? ["--user", "is-active", SYSTEMD_UNIT] : ["is-active", SYSTEMD_UNIT];
  // is-active exits non-zero when inactive, so read stdout regardless of exit code.
  const out = await new Promise<string | null>((resolve) => {
    execFile("systemctl", args, { timeout: 4000 }, (_err, stdout) => {
      const s = stdout.toString().trim();
      resolve(s || null);
    });
  });
  return out; // "active" when running; "inactive"/"failed"/"unknown"/null otherwise
}

// ---- aggregate ---------------------------------------------------------------

/**
 * Aggregate all evidence into a single verdict. `running` reflects the health
 * probe (authoritative). `method` prefers the recorded manifest, then falls back
 * to whichever backend's identity probe fired.
 */
export async function detect(opts: { home?: string; port?: number } = {}): Promise<DetectResult> {
  const manifest = readManifest(opts.home);
  const port = opts.port ?? manifest?.port ?? DEFAULT_PORT;
  const evidence: Evidence[] = [];

  const [health, docker, sysUser, sysSystem] = await Promise.all([
    probeHealth(port),
    detectDocker(),
    detectSystemd("user"),
    detectSystemd("system"),
  ]);

  if (health) evidence.push({ kind: "health", detail: `healthy on :${port} (${health.adapter})` });
  if (docker) evidence.push({ kind: "docker", detail: `container ${docker.id} ${docker.status}` });
  if (sysUser === "active") evidence.push({ kind: "systemd-user", detail: `${SYSTEMD_UNIT} active (--user)` });
  if (sysSystem === "active") evidence.push({ kind: "systemd-system", detail: `${SYSTEMD_UNIT} active (system)` });
  if (manifest) evidence.push({ kind: "manifest", detail: `install.json: ${manifest.method}` });

  let method: DetectResult["method"] = manifest?.method;
  if (!method) {
    if (docker) method = "docker";
    else if (sysUser === "active") method = "systemd-user";
    else if (sysSystem === "active") method = "systemd-system";
    else if (health) method = "process"; // serving, but not via a backend we recognize
  }

  return { running: Boolean(health), method, health: health ?? undefined, manifest, evidence };
}
