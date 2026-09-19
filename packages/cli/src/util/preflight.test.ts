/**
 * Capability detection decides which install methods the menu offers, so a probe
 * that mis-reports takes a working host off the menu (or offers a path that will
 * fail). `node:child_process` is stubbed; nothing here shells out for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:net";

type ExecResult = { err: boolean; out: string };
let execImpl: (cmd: string, args: string[]) => ExecResult = () => ({ err: true, out: "" });
let execCalls: { cmd: string; args: string[] }[] = [];

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    execCalls.push({ cmd, args });
    const r = execImpl(cmd, args);
    setTimeout(() => cb(r.err ? new Error("fail") : null, r.out), 0);
  },
}));

const preflight = await import("./preflight.js");

const okOut = (out = "") => ({ err: false, out });
const nope = () => ({ err: true, out: "" });

beforeEach(() => {
  execCalls = [];
  execImpl = () => nope();
});
afterEach(() => vi.restoreAllMocks());

describe("probeDocker", () => {
  it("reports unusable when the CLI is absent, and never asks the daemon", async () => {
    const d = await preflight.probeDocker();
    expect(d).toEqual({ present: false, daemon: false, detail: "docker CLI not found" });
    expect(execCalls.map((c) => c.args[0])).toEqual(["--version"]);
  });

  it("reports present-but-unusable when the CLI exists and the daemon does not answer", async () => {
    execImpl = (_c, a) => (a[0] === "--version" ? okOut("Docker version 27.0") : nope());
    const d = await preflight.probeDocker();
    expect(d.present).toBe(true);
    expect(d.daemon).toBe(false);
    expect(d.detail).toMatch(/daemon not reachable/);
  });

  it("reports usable and quotes the server version when the daemon answers", async () => {
    execImpl = (_c, a) => (a[0] === "--version" ? okOut("Docker version 27.0") : okOut("27.0.3"));
    const d = await preflight.probeDocker();
    expect(d).toEqual({ present: true, daemon: true, detail: "daemon 27.0.3" });
  });
});

describe("probeSystemd", () => {
  it("reports nothing usable when systemctl is missing", async () => {
    const s = await preflight.probeSystemd(false);
    expect(s).toEqual({ present: false, user: false, system: false, detail: "systemctl not found" });
  });

  it("accepts a user manager that exits non-zero but reports a running-ish state", async () => {
    // `systemctl --user is-system-running` exits 1 on "degraded" — still usable.
    execImpl = (_c, a) =>
      a[0] === "--version" ? okOut("systemd 257\n+PAM +AUDIT") : { err: true, out: "degraded" };
    const s = await preflight.probeSystemd(false);
    expect(s.user).toBe(true);
    expect(s.detail).toBe("systemd 257"); // first line only
  });

  it("rejects a user manager with no bus at all", async () => {
    execImpl = (_c, a) => (a[0] === "--version" ? okOut("systemd 257") : { err: true, out: "Failed to connect to bus" });
    const s = await preflight.probeSystemd(false);
    expect(s.user).toBe(false);
  });

  it("gates the system scope on the root flag it is handed", async () => {
    execImpl = (_c, a) => (a[0] === "--version" ? okOut("systemd 257") : okOut("running"));
    expect((await preflight.probeSystemd(false)).system).toBe(false);
    expect((await preflight.probeSystemd(true)).system).toBe(true);
  });
});

describe("probeSudo", () => {
  it("probeSudo uses the non-interactive form so it can never block on a password", async () => {
    execImpl = () => okOut("");
    expect(await preflight.probeSudo()).toBe(true);
    expect(execCalls[0]).toEqual({ cmd: "sudo", args: ["-n", "true"] });
  });

  it("probeSudo returns false rather than throwing when sudo refuses", async () => {
    expect(await preflight.probeSudo()).toBe(false);
  });
});

describe("portInUse", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("detects an occupied port", async () => {
    await expect(preflight.portInUse(port)).resolves.toBe(true);
  });

  it("reports a refused connection as free (not an error)", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await expect(preflight.portInUse(port)).resolves.toBe(false);
  });
});

describe("detectCapabilities", () => {
  it("upgrades the system scope when passwordless sudo is available", async () => {
    execImpl = (cmd, a) => {
      if (cmd === "docker") return nope();
      if (cmd === "systemctl") return a[0] === "--version" ? okOut("systemd 257") : okOut("running");
      if (cmd === "sudo") return okOut("");
      return nope();
    };
    const caps = await preflight.detectCapabilities();
    expect(caps.sudo).toBe(true);
    expect(caps.systemd.system).toBe(true); // probeSystemd(root=false) said false
    expect(caps.docker.daemon).toBe(false);
    expect(caps.node.version).toBe(process.version);
  });

  it("keeps the system scope closed with neither root nor sudo", async () => {
    execImpl = (cmd, a) =>
      cmd === "systemctl" ? (a[0] === "--version" ? okOut("systemd 257") : okOut("running")) : nope();
    const caps = await preflight.detectCapabilities();
    expect(caps.systemd.present).toBe(true);
    expect(caps.systemd.system).toBe(false);
  });

  it("never throws when every probe fails", async () => {
    const caps = await preflight.detectCapabilities();
    expect(caps.docker.present).toBe(false);
    expect(caps.systemd.present).toBe(false);
    expect(caps.sudo).toBe(false);
  });
});
