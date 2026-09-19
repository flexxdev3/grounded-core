/**
 * The install-path decision logic: the double-install guard, capability-gated
 * method selection, and what gets recorded afterwards. Every side-effecting
 * boundary (detect / bootstrap / materialize / health) is stubbed — this suite
 * asserts *which* path the installer chooses, never that docker ran.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Capabilities } from "../util/preflight.js";

// ---- boundary stubs ----------------------------------------------------------

const detect = vi.fn();
const bootstrap = vi.fn();
const writeManifest = vi.fn();
const detectCapabilities = vi.fn();
const materializeDocker = vi.fn();
const materializeSystemd = vi.fn();
const healthPoll = vi.fn();

let out: string[] = [];

vi.mock("@grounded/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@grounded/core")>();
  return {
    ...actual,
    detect: (...a: unknown[]) => detect(...a),
    bootstrap: (...a: unknown[]) => bootstrap(...a),
    writeManifest: (...a: unknown[]) => writeManifest(...a),
  };
});

vi.mock("../util/preflight.js", () => ({ detectCapabilities: () => detectCapabilities() }));

vi.mock("../util/service.js", () => ({
  materializeDocker: (...a: unknown[]) => materializeDocker(...a),
  materializeSystemd: (...a: unknown[]) => materializeSystemd(...a),
  healthPoll: (...a: unknown[]) => healthPoll(...a),
}));

/** `fail()` calls process.exit(1); make it a throw so tests can assert on it. */
class Failed extends Error {}
vi.mock("../util/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/output.js")>();
  return {
    ...actual,
    line: (s = "") => void out.push(s),
    header: (s: string) => void out.push(s),
    field: (k: string, v: string) => void out.push(`${k}=${v}`),
    printJson: (v: unknown) => void out.push(JSON.stringify(v)),
    fail: (m: string) => {
      throw new Failed(m);
    },
  };
});

const { installCommand } = await import("./install.js");

// ---- fixtures ----------------------------------------------------------------

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    docker: { present: true, daemon: true, detail: "daemon 27.0" },
    systemd: { present: true, user: true, system: true, detail: "systemd 257" },
    node: { version: process.version },
    root: false,
    sudo: true,
    ...over,
  };
}

const NO_DOCKER = { present: false, daemon: false, detail: "docker CLI not found" };
const NO_SYSTEMD = { present: false, user: false, system: false, detail: "systemctl not found" };

function run(argv: string[], global: Record<string, unknown> = {}) {
  // installCommand() *is* the `install` subcommand, so drop the verb from argv.
  const rest = argv[0] === "install" ? argv.slice(1) : argv;
  const cmd = installCommand(() => global);
  return cmd.parseAsync(["node", "grounded", ...rest]);
}

const printed = () => out.join("\n");

beforeEach(() => {
  out = [];
  vi.clearAllMocks();
  detect.mockResolvedValue({ running: false, evidence: [], method: null });
  bootstrap.mockResolvedValue({ home: "/tmp/cab", configPath: "/tmp/cab/config.toml", wroteConfig: true });
  detectCapabilities.mockResolvedValue(caps());
  materializeDocker.mockResolvedValue(undefined);
  materializeSystemd.mockResolvedValue(undefined);
  healthPoll.mockResolvedValue(true);
});

// ---- the double-install guard ------------------------------------------------

describe("double-install guard", () => {
  it("refuses to install over a live instance and touches nothing", async () => {
    detect.mockResolvedValue({
      running: true,
      method: "docker",
      evidence: [{ kind: "health", detail: "http://127.0.0.1:7437/health ok" }],
    });
    await run(["install", "-y"]);
    expect(printed()).toContain("Grounded is already running");
    expect(printed()).toContain("health=http://127.0.0.1:7437/health ok");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(materializeDocker).not.toHaveBeenCalled();
    expect(materializeSystemd).not.toHaveBeenCalled();
    expect(writeManifest).not.toHaveBeenCalled();
  });

  it("names --force as the escape hatch and warns about two writers on one cabinet", async () => {
    detect.mockResolvedValue({ running: true, method: "systemd-user", evidence: [] });
    await run(["install", "-y"]);
    expect(printed()).toContain("--force");
    expect(printed()).toContain("two writers on one cabinet");
  });

  it("--force installs anyway", async () => {
    detect.mockResolvedValue({ running: true, method: "docker", evidence: [] });
    await run(["install", "-y", "--force"]);
    expect(materializeDocker).toHaveBeenCalledTimes(1);
  });

  it("probes for an existing instance on the requested home and port", async () => {
    await run(["install", "-y", "--port", "9999"], { home: "/tmp/other" });
    expect(detect).toHaveBeenCalledWith({ home: "/tmp/other", port: 9999 });
  });
});

// ---- port validation ---------------------------------------------------------

describe("--port validation", () => {
  it("rejects a non-numeric port before probing anything", async () => {
    await expect(run(["install", "-y", "--port", "abc"])).rejects.toThrow(/invalid --port abc/);
    expect(detect).not.toHaveBeenCalled();
  });

  it("rejects a fractional or non-positive port", async () => {
    await expect(run(["install", "-y", "--port", "80.5"])).rejects.toThrow(/invalid --port/);
    await expect(run(["install", "-y", "--port", "0"])).rejects.toThrow(/invalid --port/);
  });

  it("defaults to 7437 when --port is omitted", async () => {
    await run(["install", "-y"]);
    expect(materializeDocker).toHaveBeenCalledWith(expect.objectContaining({ port: 7437 }));
    expect(healthPoll).toHaveBeenCalledWith(7437);
  });
});

// ---- capability-gated method selection ---------------------------------------

describe("method selection", () => {
  it("defaults to docker when the daemon is reachable", async () => {
    await run(["install", "-y"]);
    expect(materializeDocker).toHaveBeenCalledTimes(1);
    expect(materializeSystemd).not.toHaveBeenCalled();
    expect(printed()).toContain("selected Docker container (default)");
  });

  it("falls to the first available method when docker's daemon is down", async () => {
    detectCapabilities.mockResolvedValue(caps({ docker: NO_DOCKER }));
    await run(["install", "-y"]);
    expect(materializeSystemd).toHaveBeenCalledWith("user", expect.objectContaining({ port: 7437 }));
    expect(materializeDocker).not.toHaveBeenCalled();
  });

  it("falls through to the system scope when neither docker nor a user manager exist", async () => {
    detectCapabilities.mockResolvedValue(
      caps({ docker: NO_DOCKER, systemd: { present: true, user: false, system: true, detail: "systemd" } }),
    );
    await run(["install", "-y"]);
    expect(materializeSystemd).toHaveBeenCalledWith("system", expect.anything());
  });

  it("fails with actionable guidance when no method is available at all", async () => {
    detectCapabilities.mockResolvedValue(caps({ docker: NO_DOCKER, systemd: NO_SYSTEMD }));
    await expect(run(["install", "-y"])).rejects.toThrow(/no install method available/);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("--method wins over the default", async () => {
    await run(["install", "-y", "--method", "systemd-user"]);
    expect(materializeSystemd).toHaveBeenCalledWith("user", expect.anything());
    expect(materializeDocker).not.toHaveBeenCalled();
  });

  it("--method systemd-system maps to the system scope", async () => {
    await run(["install", "-y", "--method", "systemd-system"]);
    expect(materializeSystemd).toHaveBeenCalledWith("system", expect.anything());
  });

  it("rejects an unknown --method", async () => {
    await expect(run(["install", "-y", "--method", "kubernetes"])).rejects.toThrow(
      /--method must be docker \| systemd-user \| systemd-system/,
    );
  });

  it("refuses an explicitly requested method the host cannot do, quoting the reason", async () => {
    detectCapabilities.mockResolvedValue(caps({ docker: { present: true, daemon: false, detail: "daemon not reachable" } }));
    await expect(run(["install", "-y", "--method", "docker"])).rejects.toThrow(
      /Docker container unavailable: daemon not reachable/,
    );
    expect(materializeDocker).not.toHaveBeenCalled();
  });

  it("refuses systemd-system without root or passwordless sudo", async () => {
    detectCapabilities.mockResolvedValue(
      caps({ systemd: { present: true, user: true, system: false, detail: "systemd" } }),
    );
    await expect(run(["install", "-y", "--method", "systemd-system"])).rejects.toThrow(
      /needs root or passwordless sudo/,
    );
  });
});

// ---- cabinet + options threading ---------------------------------------------

describe("cabinet and options", () => {
  it("bootstraps the cabinet before materializing the backend", async () => {
    const order: string[] = [];
    bootstrap.mockImplementation(async () => {
      order.push("bootstrap");
      return { home: "/tmp/cab", configPath: "/tmp/cab/config.toml", wroteConfig: true };
    });
    materializeDocker.mockImplementation(async () => void order.push("materialize"));
    await run(["install", "-y"]);
    expect(order).toEqual(["bootstrap", "materialize"]);
  });

  it("resolves the cabinet home from --home and hands the same path to bootstrap", async () => {
    await run(["install", "-y"], { home: "/tmp/mycab" });
    expect(bootstrap).toHaveBeenCalledWith({ home: "/tmp/mycab" });
    expect(materializeDocker).toHaveBeenCalledWith(expect.objectContaining({ home: "/tmp/mycab" }));
  });

  it("falls back to GROUNDED_HOME when --home is absent", async () => {
    process.env.GROUNDED_HOME = "/tmp/envcab";
    try {
      await run(["install", "-y"]);
      expect(bootstrap).toHaveBeenCalledWith({ home: "/tmp/envcab" });
    } finally {
      delete process.env.GROUNDED_HOME;
    }
  });

  it("aborts on a bootstrap failure without materializing anything", async () => {
    bootstrap.mockRejectedValue(new Error("permission denied"));
    await expect(run(["install", "-y"])).rejects.toThrow(/bootstrap failed: permission denied/);
    expect(materializeDocker).not.toHaveBeenCalled();
  });

  it("threads --token and --image into the docker backend", async () => {
    await run(["install", "-y", "--token", "s3cr3t", "--image", "ghcr.io/acme/grounded:1"]);
    expect(materializeDocker).toHaveBeenCalledWith({
      home: expect.any(String),
      port: 7437,
      token: "s3cr3t",
      image: "ghcr.io/acme/grounded:1",
    });
  });

  // FIXED: --image used to be accepted for every method but only reached
  // materializeDocker, so a systemd install silently ignored it. It is a
  // Docker-only concept (systemd runs the locally-resolved grounded-api directly),
  // so it is now rejected rather than dropped.
  it("rejects --image on the systemd path instead of silently dropping it", async () => {
    await expect(
      run(["install", "-y", "--method", "systemd-user", "--image", "ghcr.io/acme/grounded:1"]),
    ).rejects.toThrow(/--image applies only to --method docker/);
    expect(materializeSystemd).not.toHaveBeenCalled();
    expect(materializeDocker).not.toHaveBeenCalled();
  });

  it("the --image rejection names both ways forward and the offending ref", async () => {
    const err = await run([
      "install", "-y", "--method", "systemd-system", "--image", "ghcr.io/acme/grounded:1",
    ]).catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain("ghcr.io/acme/grounded:1");
    expect(msg).toContain("--method docker --image ghcr.io/acme/grounded:1");
    expect(msg).toContain("grounded install --method systemd-system");
  });

  it("rejects --image before bootstrapping anything", async () => {
    await expect(
      run(["install", "-y", "--method", "systemd-user", "--image", "ghcr.io/acme/grounded:1"]),
    ).rejects.toThrow(/--image applies only to --method docker/);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(writeManifest).not.toHaveBeenCalled();
  });

  it("still accepts --image on the docker path", async () => {
    await run(["install", "-y", "--method", "docker", "--image", "ghcr.io/acme/grounded:1"]);
    expect(materializeDocker).toHaveBeenCalledWith(
      expect.objectContaining({ image: "ghcr.io/acme/grounded:1" }),
    );
  });

  it("leaves the systemd path untouched when --image is absent", async () => {
    await run(["install", "-y", "--method", "systemd-user"]);
    expect(materializeSystemd).toHaveBeenCalledWith("user", {
      home: expect.any(String),
      port: 7437,
      token: undefined,
    });
  });

  it("surfaces a materialize failure verbatim and records no manifest", async () => {
    materializeDocker.mockRejectedValue(new Error("docker run failed (exit 125)"));
    await expect(run(["install", "-y"])).rejects.toThrow(/docker run failed \(exit 125\)/);
    expect(writeManifest).not.toHaveBeenCalled();
  });
});

// ---- health gate + manifest --------------------------------------------------

describe("health gate and manifest", () => {
  it("fails and points at `grounded logs` when the service never comes up", async () => {
    healthPoll.mockResolvedValue(false);
    await expect(run(["install", "-y", "--port", "9001"])).rejects.toThrow(
      /did not become healthy on :9001 within 30s/,
    );
    expect(writeManifest).not.toHaveBeenCalled();
  });

  it("records the chosen method and port as the source of truth for later re-runs", async () => {
    await run(["install", "-y", "--method", "systemd-user", "--port", "9001"], { home: "/tmp/cab" });
    expect(writeManifest).toHaveBeenCalledWith(
      { method: "systemd-user", port: 9001, version: "0.1.0", installedAt: expect.any(String) },
      "/tmp/cab",
    );
    const [manifest] = writeManifest.mock.calls[0]!;
    expect(new Date((manifest as { installedAt: string }).installedAt).toString()).not.toBe("Invalid Date");
  });

  it("treats a manifest write failure as non-fatal (detection still works by probe)", async () => {
    writeManifest.mockImplementation(() => {
      throw new Error("read-only fs");
    });
    await expect(run(["install", "-y"])).resolves.toBeDefined();
    expect(printed()).toContain("Grounded is live ✓");
  });

  it("finishes by printing the console URL and the Claude Code MCP snippet", async () => {
    await run(["install", "-y", "--port", "9001"]);
    const text = printed();
    expect(text).toContain("console=http://127.0.0.1:9001/");
    expect(text).toContain("health=http://127.0.0.1:9001/health");
    expect(text).toContain("grounded mcp install");
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"grounded-mcp"');
  });

  it("nudges --token only when the API was left unauthenticated", async () => {
    await run(["install", "-y"]);
    expect(printed()).toContain("unauthenticated on loopback");
    out = [];
    await run(["install", "-y", "--token", "tok"]);
    expect(printed()).not.toContain("unauthenticated on loopback");
    expect(printed()).toContain("auth=bearer token");
  });
});
