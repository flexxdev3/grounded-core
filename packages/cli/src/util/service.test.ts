/**
 * service.ts is the shell-out layer of the installer. Nothing here may actually
 * run docker/systemctl/npm, so `node:child_process` is stubbed at the boundary
 * and the tests assert on the exact argv that would have been executed — that
 * argv IS the installer's contract with the host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---- boundary stubs ----------------------------------------------------------

interface SpawnCall {
  cmd: string;
  args: string[];
}

let spawnCalls: SpawnCall[] = [];
/** exit code per command signature; default 0. Key is `cmd argv[0]` or `cmd`. */
let spawnExit: (cmd: string, args: string[]) => number = () => 0;
/** stdout per execFile invocation; null = treat as a failure. */
let execOut: (cmd: string, args: string[]) => string | null = () => "";
/** which paths existsSync() should report as present. */
let existing = new Set<string>();
/** stdin content handed to `sudo tee`. */
let teeWrites: string[] = [];

function fakeChild(code: number, collectStdin?: (s: string) => void) {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const child = {
    on(ev: string, fn: (arg?: unknown) => void) {
      (handlers[ev] ??= []).push(fn);
      return child;
    },
    stdin: {
      end(content?: string) {
        if (collectStdin && content !== undefined) collectStdin(content);
      },
    },
  };
  // fire `close` once the caller has finished registering handlers
  setTimeout(() => {
    for (const fn of handlers.close ?? []) fn(code);
  }, 0);
  return child;
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    const code = spawnExit(cmd, args);
    if (code === -1) {
      // simulate ENOENT: emit "error" instead of "close"
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        on(ev: string, fn: (arg?: unknown) => void) {
          (handlers[ev] ??= []).push(fn);
          return child;
        },
        stdin: { end() {} },
      };
      setTimeout(() => {
        for (const fn of handlers.error ?? []) fn(new Error("ENOENT"));
      }, 0);
      return child;
    }
    return fakeChild(code, cmd === "sudo" && args[0] === "tee" ? (s) => teeWrites.push(s) : undefined);
  },
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    const out = execOut(cmd, args);
    setTimeout(() => (out === null ? cb(new Error("failed"), "") : cb(null, out)), 0);
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: string) => existing.has(String(p)) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) };
});

/** Fresh module instance — service.ts reads GROUNDED_IMAGE at module scope. */
async function loadService(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import("./service.js");
}

const argvOf = (cmd: string) => spawnCalls.filter((c) => c.cmd === cmd).map((c) => c.args);
const ranAny = (cmd: string, first: string) =>
  spawnCalls.some((c) => c.cmd === cmd && c.args[0] === first);

beforeEach(() => {
  spawnCalls = [];
  teeWrites = [];
  existing = new Set();
  spawnExit = () => 0;
  execOut = () => "";
  delete process.env.GROUNDED_IMAGE;
  delete process.env.GROUNDED_BUILD_CONTEXT;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GROUNDED_IMAGE;
  delete process.env.GROUNDED_BUILD_CONTEXT;
});

// ---- process helpers ---------------------------------------------------------

describe("stream / capture", () => {
  it("stream resolves the child's exit code", async () => {
    spawnExit = () => 3;
    const { stream } = await loadService();
    await expect(stream("docker", ["ps"])).resolves.toBe(3);
  });

  it("stream resolves 127 when the binary is missing (never rejects)", async () => {
    spawnExit = () => -1;
    const { stream } = await loadService();
    await expect(stream("docker", ["ps"])).resolves.toBe(127);
  });

  it("capture trims stdout and returns null on failure", async () => {
    const { capture } = await loadService();
    execOut = () => "  /usr/local  \n";
    await expect(capture("npm", ["prefix", "-g"])).resolves.toBe("/usr/local");
    execOut = () => null;
    await expect(capture("npm", ["prefix", "-g"])).resolves.toBeNull();
  });
});

// ---- build context -----------------------------------------------------------

describe("dockerBuildContext", () => {
  it("honours GROUNDED_BUILD_CONTEXT when it holds a Dockerfile", async () => {
    existing.add(join("/opt/src", "Dockerfile"));
    const { dockerBuildContext } = await loadService({ GROUNDED_BUILD_CONTEXT: "/opt/src" });
    expect(dockerBuildContext()).toBe("/opt/src");
  });

  it("ignores GROUNDED_BUILD_CONTEXT without a Dockerfile and falls back to the repo guess", async () => {
    const { dockerBuildContext } = await loadService({ GROUNDED_BUILD_CONTEXT: "/opt/empty" });
    expect(dockerBuildContext()).toBeNull();
  });

  it("returns null when neither the env override nor the repo guess has a Dockerfile", async () => {
    const { dockerBuildContext } = await loadService();
    expect(dockerBuildContext()).toBeNull();
  });

  // The four-levels-up guess is only meaningful in a repo checkout. Installed
  // from npm the same walk lands inside node_modules/, where an unrelated
  // Dockerfile would otherwise be built as if it were ours — so the guess is
  // identity-checked, not merely Dockerfile-checked.
  it("accepts the four-levels-up guess only when it looks like the grounded-core repo root", async () => {
    const { dockerBuildContext } = await loadService();
    const modDir = dirname(fileURLToPath(import.meta.url)); // packages/cli/src/util
    const root = resolve(modDir, "..", "..", "..", "..");
    const markers = ["Dockerfile", "packages", "pnpm-workspace.yaml"];

    // a Dockerfile alone is NOT enough
    existing = new Set([join(root, "Dockerfile")]);
    expect(dockerBuildContext()).toBeNull();

    // every marker present → accepted
    existing = new Set(markers.map((m) => join(root, m)));
    expect(dockerBuildContext()).toBe(root);

    // any single marker missing → rejected
    for (const drop of markers) {
      existing = new Set(markers.filter((m) => m !== drop).map((m) => join(root, m)));
      expect(dockerBuildContext(), `missing ${drop}`).toBeNull();
    }
  });

  it("trusts an explicit GROUNDED_BUILD_CONTEXT even under node_modules — only the guess is identity-checked", async () => {
    existing = new Set([join("/x/node_modules/thing", "Dockerfile")]);
    const { dockerBuildContext } = await loadService({
      GROUNDED_BUILD_CONTEXT: "/x/node_modules/thing",
    });
    expect(dockerBuildContext()).toBe("/x/node_modules/thing");
  });

});

// ---- image resolution (the shipped installer bug) ----------------------------

describe("image resolution", () => {
  // KNOWN DEFECT (shipped, now documented in-source): the default image ref is
  // the bare local tag "grounded:latest" (service.ts:29). A bare tag has no "/",
  // so isRemoteRef() says it is not registry-pullable and `docker pull` is never
  // attempted. Combined with an npm install having no build context, the DEFAULT
  // `grounded install --method docker` cannot succeed at all — it can only fail
  // with guidance. It stays a defect until a registry image is published; this
  // test pins the failure so the day the image ships, it goes red.
  it("KNOWN DEFECT: the default ref is never pulled, only built", async () => {
    const { materializeDocker } = await loadService();
    execOut = () => ""; // `docker images -q grounded:latest` → empty = not present
    await expect(materializeDocker({ port: 7437 })).rejects.toThrow(
      /image grounded:latest not found and no build context available/,
    );
    expect(ranAny("docker", "pull")).toBe(false);
    expect(ranAny("docker", "build")).toBe(false);
    // and the error must not claim a pull was tried
    expect(spawnCalls).toHaveLength(0);
  });

  it("the default-ref failure names all three ways out instead of failing bare", async () => {
    const { materializeDocker } = await loadService();
    execOut = () => "";
    const err = await materializeDocker({ port: 7437 }).catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain("bare local tag");
    expect(msg).toContain("GROUNDED_BUILD_CONTEXT=/path/to/grounded-core");
    expect(msg).toContain("--image ghcr.io/<org>/grounded:<tag>");
    expect(msg).toContain("--method systemd-user");
  });

  it("builds from source when the default ref is absent but a context exists", async () => {
    existing.add(join("/opt/src", "Dockerfile"));
    const { materializeDocker } = await loadService({ GROUNDED_BUILD_CONTEXT: "/opt/src" });
    execOut = () => "";
    await materializeDocker({ port: 7437 });
    expect(argvOf("docker")[0]).toEqual(["build", "-t", "grounded:latest", "/opt/src"]);
    expect(ranAny("docker", "pull")).toBe(false);
    expect(argvOf("docker")[1]?.[0]).toBe("run");
  });

  it("pulls a registry ref (a ref containing '/') before falling back to a build", async () => {
    const { materializeDocker } = await loadService();
    execOut = () => "";
    await materializeDocker({ port: 7437, image: "ghcr.io/acme/grounded:1.2.3" });
    expect(argvOf("docker")[0]).toEqual(["pull", "ghcr.io/acme/grounded:1.2.3"]);
    expect(ranAny("docker", "build")).toBe(false);
    expect(argvOf("docker")[1]?.[0]).toBe("run");
  });

  it("falls back to a build when the pull of a registry ref fails", async () => {
    existing.add(join("/opt/src", "Dockerfile"));
    const { materializeDocker } = await loadService({ GROUNDED_BUILD_CONTEXT: "/opt/src" });
    execOut = () => "";
    spawnExit = (_cmd, args) => (args[0] === "pull" ? 1 : 0);
    await materializeDocker({ port: 7437, image: "ghcr.io/acme/grounded:1.2.3" });
    expect(argvOf("docker").map((a) => a[0])).toEqual(["pull", "build", "run"]);
    expect(argvOf("docker")[1]).toEqual(["build", "-t", "ghcr.io/acme/grounded:1.2.3", "/opt/src"]);
  });

  it("reports the failed pull in the error when there is no build context", async () => {
    const { materializeDocker } = await loadService();
    execOut = () => "";
    spawnExit = () => 1;
    await expect(materializeDocker({ image: "ghcr.io/acme/grounded:1" })).rejects.toThrow(
      /not found \(and pull failed\) and no build context available/,
    );
  });

  it("skips both pull and build when the image is already present locally", async () => {
    const { materializeDocker } = await loadService();
    execOut = (cmd, args) => (cmd === "docker" && args[0] === "images" ? "sha256:deadbeef" : "");
    await materializeDocker({ port: 7437 });
    expect(argvOf("docker").map((a) => a[0])).toEqual(["run"]);
  });

  it("GROUNDED_IMAGE overrides the default and is read at module load", async () => {
    const { materializeDocker, dockerImageExists } = await loadService({
      GROUNDED_IMAGE: "ghcr.io/acme/grounded:env",
    });
    let queried = "";
    execOut = (_cmd, args) => {
      queried = args[1] === "-q" ? String(args[2]) : queried;
      return "sha256:1";
    };
    await expect(dockerImageExists()).resolves.toBe(true);
    expect(queried).toBe("ghcr.io/acme/grounded:env");
    await materializeDocker({ port: 7437 });
    expect(argvOf("docker")[0]?.at(-1)).toBe("ghcr.io/acme/grounded:env");
  });

  it("the explicit --image option beats GROUNDED_IMAGE", async () => {
    const { materializeDocker } = await loadService({ GROUNDED_IMAGE: "ghcr.io/acme/from-env:1" });
    execOut = () => "sha256:1";
    await materializeDocker({ port: 7437, image: "ghcr.io/acme/from-flag:2" });
    expect(argvOf("docker")[0]?.at(-1)).toBe("ghcr.io/acme/from-flag:2");
  });
});

// ---- docker run argv ---------------------------------------------------------

describe("materializeDocker", () => {
  it("renders a detached, restarting, labelled, cabinet-mounted container", async () => {
    const { materializeDocker } = await loadService();
    execOut = () => "sha256:1";
    await materializeDocker({ home: "/tmp/cab", port: 9001 });
    const args = argvOf("docker")[0]!;
    expect(args[0]).toBe("run");
    expect(args).toContain("-d");
    expect(args).toContain("--restart");
    expect(args).toContain("unless-stopped");
    expect(args).toContain("127.0.0.1:9001:9001"); // loopback-only publish
    expect(args).toContain("/tmp/cab:/cabinet");
    expect(args).toContain("GROUNDED_API_PORT=9001");
    expect(args.at(-1)).toBe("grounded:latest");
  });

  it("passes a bearer token through as an env var, and omits it when unset", async () => {
    const { materializeDocker } = await loadService();
    execOut = () => "sha256:1";
    await materializeDocker({ port: 7437, token: "s3cr3t" });
    expect(argvOf("docker")[0]).toContain("GROUNDED_API_TOKEN=s3cr3t");

    spawnCalls = [];
    await materializeDocker({ port: 7437 });
    expect(argvOf("docker")[0]!.join(" ")).not.toContain("GROUNDED_API_TOKEN");
  });

  it("throws when `docker run` exits non-zero", async () => {
    const { materializeDocker } = await loadService();
    execOut = () => "sha256:1";
    spawnExit = () => 125;
    await expect(materializeDocker({ port: 7437 })).rejects.toThrow(/docker run failed \(exit 125\)/);
  });
});

// ---- systemd -----------------------------------------------------------------

describe("materializeSystemd", () => {
  it("aborts before touching systemd when the global npm install fails", async () => {
    const { materializeSystemd } = await loadService();
    spawnExit = (cmd) => (cmd === "npm" ? 1 : 0);
    await expect(materializeSystemd("user", { port: 7437 })).rejects.toThrow(
      /npm i -g @grounded\/api failed \(exit 1\)/,
    );
    expect(spawnCalls.map((c) => c.cmd)).toEqual(["npm"]);
  });

  it("user scope: installs the api, writes the unit, reloads and enables --now", async () => {
    const { materializeSystemd } = await loadService();
    execOut = () => null; // `npm prefix -g` unavailable → PATH fallback
    await materializeSystemd("user", { port: 7437 });
    expect(spawnCalls[0]).toEqual({ cmd: "npm", args: ["install", "-g", "@grounded/api"] });
    expect(argvOf("systemctl")).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "grounded.service"],
    ]);
  });

  it("system scope without root writes the unit through `sudo tee` and drives sudo systemctl", async () => {
    const { materializeSystemd } = await loadService();
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    execOut = () => null;
    await materializeSystemd("system", { port: 7437, token: "tok" });
    expect(spawnCalls[1]).toEqual({ cmd: "sudo", args: ["tee", "/etc/systemd/system/grounded.service"] });
    expect(teeWrites).toHaveLength(1);
    expect(teeWrites[0]).toContain("Environment=GROUNDED_API_PORT=7437");
    expect(teeWrites[0]).toContain("Environment=GROUNDED_API_TOKEN=tok");
    expect(teeWrites[0]).toContain("WantedBy=multi-user.target");
    expect(argvOf("sudo").slice(1)).toEqual([
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", "grounded.service"],
    ]);
  });

  it("system scope as root drives systemctl directly, no sudo", async () => {
    const { materializeSystemd } = await loadService();
    vi.spyOn(process, "getuid").mockReturnValue(0);
    execOut = () => null;
    await materializeSystemd("system", { port: 7437 });
    expect(argvOf("systemctl")).toEqual([["daemon-reload"], ["enable", "--now", "grounded.service"]]);
  });

  it("throws when daemon-reload fails, before attempting enable", async () => {
    const { materializeSystemd } = await loadService();
    execOut = () => null;
    spawnExit = (cmd, args) => (cmd === "systemctl" && args.includes("daemon-reload") ? 4 : 0);
    await expect(materializeSystemd("user", {})).rejects.toThrow(/daemon-reload failed \(exit 4\)/);
    expect(ranAny("systemctl", "--user")).toBe(true);
    expect(argvOf("systemctl").some((a) => a.includes("enable"))).toBe(false);
  });
});

describe("resolveApiBin", () => {
  it("prefers the npm global bin shim", async () => {
    const { resolveApiBin } = await loadService();
    execOut = () => "/usr/local";
    existing.add("/usr/local/bin/grounded-api");
    await expect(resolveApiBin()).resolves.toBe("/usr/local/bin/grounded-api");
  });

  it("falls back to the package's dist/bin.js under the global prefix", async () => {
    const { resolveApiBin } = await loadService();
    execOut = () => "/usr/local";
    existing.add("/usr/local/lib/node_modules/@grounded/api/dist/bin.js");
    await expect(resolveApiBin()).resolves.toBe(
      "/usr/local/lib/node_modules/@grounded/api/dist/bin.js",
    );
  });

  it("falls back to a bare PATH lookup when npm cannot be queried", async () => {
    const { resolveApiBin } = await loadService();
    execOut = () => null;
    await expect(resolveApiBin()).resolves.toBe("grounded-api");
  });
});

// ---- lifecycle ---------------------------------------------------------------

describe("lifecycle verbs", () => {
  const cases: [string, "docker" | "systemd-user" | "systemd-system"][] = [
    ["start", "docker"],
    ["stop", "docker"],
    ["restart", "docker"],
  ];

  it.each(cases)("%s on docker targets the labelled container by name", async (verb) => {
    const svc = await loadService();
    const fn = { start: svc.startService, stop: svc.stopService, restart: svc.restartService }[verb]!;
    await fn("docker");
    expect(argvOf("docker")[0]).toEqual([verb, "grounded"]);
  });

  it("systemd-user lifecycle goes through `systemctl --user`", async () => {
    const { startService, stopService, restartService } = await loadService();
    await startService("systemd-user");
    await stopService("systemd-user");
    await restartService("systemd-user");
    expect(argvOf("systemctl")).toEqual([
      ["--user", "start", "grounded.service"],
      ["--user", "stop", "grounded.service"],
      ["--user", "restart", "grounded.service"],
    ]);
  });

  it("systemd-system lifecycle escalates through sudo when not root", async () => {
    const { startService } = await loadService();
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    await startService("systemd-system");
    expect(spawnCalls[0]).toEqual({ cmd: "sudo", args: ["systemctl", "start", "grounded.service"] });
  });
});

describe("logsService", () => {
  it("docker: --tail 200 by default, -f when following", async () => {
    const { logsService } = await loadService();
    await logsService("docker", false);
    await logsService("docker", true);
    expect(argvOf("docker")).toEqual([
      ["logs", "--tail", "200", "grounded"],
      ["logs", "-f", "grounded"],
    ]);
  });

  it("systemd-user: journalctl --user", async () => {
    const { logsService } = await loadService();
    await logsService("systemd-user", false);
    await logsService("systemd-user", true);
    expect(argvOf("journalctl")).toEqual([
      ["--user", "-u", "grounded.service", "-n", "200"],
      ["--user", "-u", "grounded.service", "-f"],
    ]);
  });

  it("systemd-system: sudo journalctl (regardless of uid)", async () => {
    const { logsService } = await loadService();
    vi.spyOn(process, "getuid").mockReturnValue(0);
    await logsService("systemd-system", false);
    expect(spawnCalls[0]).toEqual({
      cmd: "sudo",
      args: ["journalctl", "-u", "grounded.service", "-n", "200"],
    });
  });
});

describe("uninstallService", () => {
  it("docker: force-removes the container and leaves the cabinet alone", async () => {
    const { uninstallService } = await loadService();
    await uninstallService("docker");
    expect(argvOf("docker")).toEqual([["rm", "-f", "grounded"]]);
  });

  it("systemd-user: disables --now, removes the unit, then reloads", async () => {
    const { uninstallService } = await loadService();
    const fsp = await import("node:fs/promises");
    await uninstallService("systemd-user");
    expect(argvOf("systemctl")).toEqual([
      ["--user", "disable", "--now", "grounded.service"],
      ["--user", "daemon-reload"],
    ]);
    expect(fsp.rm).toHaveBeenCalledWith(expect.stringContaining("grounded.service"), { force: true });
  });

  it("systemd-system: removes the root-owned unit via sudo rm", async () => {
    const { uninstallService } = await loadService();
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    await uninstallService("systemd-system");
    expect(argvOf("sudo")).toEqual([
      ["systemctl", "disable", "--now", "grounded.service"],
      ["rm", "-f", "/etc/systemd/system/grounded.service"],
      ["systemctl", "daemon-reload"],
    ]);
  });
});

describe("healthPoll", () => {
  it("returns false rather than hanging when nothing ever comes up", async () => {
    const { healthPoll } = await loadService();
    // port 1 on loopback: connection refused, so probeHealth resolves falsy fast
    await expect(healthPoll(1, 10)).resolves.toBe(false);
  }, 20_000);
});
