/**
 * service.ts is the shell-out layer of the installer. Nothing here may actually
 * run docker/systemctl/which, so `node:child_process` is stubbed at the boundary
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

/** When set, service.ts sees this as its own module path — used to simulate the
 *  shape of a vendored install (the CLI living under node_modules/). */
let moduleFileOverride: string | null = null;

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return {
    ...actual,
    fileURLToPath: (u: string | URL) => moduleFileOverride ?? actual.fileURLToPath(u),
  };
});

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
  moduleFileOverride = null;
  spawnExit = () => 0;
  execOut = () => "";
  delete process.env.GROUNDED_IMAGE;
  delete process.env.GROUNDED_BUILD_CONTEXT;
  delete process.env.GROUNDED_API_BIN;
  delete process.env.GROUNDED_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GROUNDED_IMAGE;
  delete process.env.GROUNDED_BUILD_CONTEXT;
  delete process.env.GROUNDED_API_BIN;
  delete process.env.GROUNDED_HOME;
});

/** The shell-installer layout: ~/.grounded/lib/current/lib/api.mjs, with
 *  GROUNDED_HOME pointed at a fake cabinet so no real filesystem is consulted. */
const CAB = "/cab";
const SHIPPED_API = join(CAB, "lib", "current", "lib", "api.mjs");

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
    execOut = () => "  /usr/local/bin/grounded-api  \n";
    await expect(capture("which", ["grounded-api"])).resolves.toBe("/usr/local/bin/grounded-api");
    execOut = () => null;
    await expect(capture("which", ["grounded-api"])).resolves.toBeNull();
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

  it("returns null when neither the env override nor the guess yields a context", async () => {
    const { dockerBuildContext } = await loadService();
    expect(dockerBuildContext()).toBeNull();
  });

  // The vendored shape: dropped into someone else's node_modules/, the same
  // four-levels-up walk lands inside that tree, where an unrelated Dockerfile
  // would have been built as if it were ours. It must say null, not guess.
  it("refuses a guess under node_modules even when every marker is present", async () => {
    moduleFileOverride = "/home/u/proj/node_modules/@grounded/cli/dist/util/service.js";
    const { dockerBuildContext } = await loadService();
    const guess = "/home/u/proj/node_modules";
    existing = new Set(
      ["Dockerfile", "packages", "pnpm-workspace.yaml"].map((m) => join(guess, m)),
    );
    expect(dockerBuildContext()).toBeNull();
  });

  it("still resolves a real in-checkout root through the same walk", async () => {
    moduleFileOverride = "/home/u/grounded-core/packages/cli/dist/util/service.js";
    const { dockerBuildContext } = await loadService();
    const root = "/home/u/grounded-core";
    existing = new Set(
      ["Dockerfile", "packages", "pnpm-workspace.yaml"].map((m) => join(root, m)),
    );
    expect(dockerBuildContext()).toBe(root);
  });

  // The four-levels-up guess is only meaningful in a repo checkout. Vendored
  // into a node_modules/ tree the same walk lands inside it, where an unrelated
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
  // attempted. Combined with a non-checkout install having no build context, the DEFAULT
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
  it("never shells out to npm — there is no registry package to install", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_HOME: CAB });
    existing.add(SHIPPED_API);
    await materializeSystemd("user", { port: 7437 });
    expect(spawnCalls.some((c) => c.cmd === "npm")).toBe(false);
  });

  it("aborts before writing a unit or touching systemd when no api entry point resolves", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_HOME: CAB });
    const fsp = await import("node:fs/promises");
    execOut = () => null; // `which grounded-api` finds nothing
    await expect(materializeSystemd("user", { port: 7437 })).rejects.toThrow(
      /cannot locate a grounded-api entry point/,
    );
    expect(spawnCalls).toHaveLength(0);
    expect(fsp.writeFile).not.toHaveBeenCalled();
  });

  it("user scope: writes the unit, reloads and enables --now", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_HOME: CAB });
    existing.add(SHIPPED_API);
    await materializeSystemd("user", { port: 7437 });
    expect(argvOf("systemctl")).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "grounded.service"],
    ]);
  });

  it("system scope without root writes the unit through `sudo tee` and drives sudo systemctl", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_HOME: CAB });
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    existing.add(SHIPPED_API);
    await materializeSystemd("system", { port: 7437, token: "tok" });
    expect(spawnCalls[0]).toEqual({ cmd: "sudo", args: ["tee", "/etc/systemd/system/grounded.service"] });
    expect(teeWrites).toHaveLength(1);
    expect(teeWrites[0]).toContain("Environment=GROUNDED_API_PORT=7437");
    expect(teeWrites[0]).toContain("Environment=GROUNDED_API_TOKEN=tok");
    expect(teeWrites[0]).toContain("WantedBy=multi-user.target");
    expect(argvOf("sudo").slice(1)).toEqual([
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", "grounded.service"],
    ]);
  });

  // A bundled .mjs has no shebang and no +x, and systemd execs ExecStart
  // directly — the unit must name the interpreter or it dies 203/EXEC.
  it("renders ExecStart as `<node> <path>` for a bundled .mjs entry point", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_HOME: CAB });
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    existing.add(SHIPPED_API);
    await materializeSystemd("system", { port: 7437 });
    expect(teeWrites[0]).toContain(`ExecStart=${process.execPath} ${SHIPPED_API}`);
  });

  it("renders ExecStart bare for a real executable, with no interpreter prefix", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_API_BIN: "/usr/local/bin/grounded-api" });
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    existing.add("/usr/local/bin/grounded-api");
    await materializeSystemd("system", { port: 7437 });
    expect(teeWrites[0]).toContain("ExecStart=/usr/local/bin/grounded-api\n");
  });

  it("system scope as root drives systemctl directly, no sudo", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_HOME: CAB });
    vi.spyOn(process, "getuid").mockReturnValue(0);
    existing.add(SHIPPED_API);
    await materializeSystemd("system", { port: 7437 });
    expect(argvOf("systemctl")).toEqual([["daemon-reload"], ["enable", "--now", "grounded.service"]]);
  });

  it("throws when daemon-reload fails, before attempting enable", async () => {
    const { materializeSystemd } = await loadService({ GROUNDED_HOME: CAB });
    existing.add(SHIPPED_API);
    spawnExit = (cmd, args) => (cmd === "systemctl" && args.includes("daemon-reload") ? 4 : 0);
    await expect(materializeSystemd("user", {})).rejects.toThrow(/daemon-reload failed \(exit 4\)/);
    expect(ranAny("systemctl", "--user")).toBe(true);
    expect(argvOf("systemctl").some((a) => a.includes("enable"))).toBe(false);
  });
});

// resolveApiBin is the whole systemd story now that @grounded/api is never
// published: every tier must end in a file that exists on THIS machine, and the
// no-resolution case must be a loud error, not a bare "grounded-api" that only
// fails later inside systemd.
describe("resolveApiBin", () => {
  it("honours GROUNDED_API_BIN above every other tier", async () => {
    const { resolveApiBin } = await loadService({
      GROUNDED_API_BIN: "/opt/custom/api.mjs",
      GROUNDED_HOME: CAB,
    });
    existing.add("/opt/custom/api.mjs");
    existing.add(SHIPPED_API);
    await expect(resolveApiBin()).resolves.toBe("/opt/custom/api.mjs");
  });

  it("errors on a GROUNDED_API_BIN that does not exist rather than trusting it blindly", async () => {
    const { resolveApiBin } = await loadService({ GROUNDED_API_BIN: "/opt/gone/api.mjs" });
    await expect(resolveApiBin()).rejects.toThrow(
      /GROUNDED_API_BIN is set to \/opt\/gone\/api\.mjs, but no file exists there/,
    );
  });

  it("finds the shell-installer layout under GROUNDED_HOME", async () => {
    const { resolveApiBin } = await loadService({ GROUNDED_HOME: CAB });
    existing.add(SHIPPED_API);
    await expect(resolveApiBin()).resolves.toBe(SHIPPED_API);
  });

  it("falls back to a grounded-api resolved through `which`, never a bare name", async () => {
    const { resolveApiBin } = await loadService({ GROUNDED_HOME: CAB });
    execOut = (cmd, args) =>
      cmd === "which" && args[0] === "grounded-api" ? "/usr/local/bin/grounded-api\n" : null;
    existing.add("/usr/local/bin/grounded-api");
    await expect(resolveApiBin()).resolves.toBe("/usr/local/bin/grounded-api");
  });

  it("ignores a `which` hit whose path does not exist (stale shim / hashed shell)", async () => {
    const { resolveApiBin } = await loadService({ GROUNDED_HOME: CAB });
    execOut = () => "/usr/local/bin/grounded-api";
    await expect(resolveApiBin()).rejects.toThrow(/cannot locate a grounded-api entry point/);
  });

  it("falls back to the workspace build when running out of a repo checkout", async () => {
    moduleFileOverride = "/home/u/grounded-core/packages/cli/dist/util/service.js";
    const { resolveApiBin } = await loadService({ GROUNDED_HOME: CAB });
    execOut = () => null;
    const root = "/home/u/grounded-core";
    existing = new Set([
      ...["Dockerfile", "packages", "pnpm-workspace.yaml"].map((m) => join(root, m)),
      join(root, "packages", "api", "dist", "bin.js"),
    ]);
    await expect(resolveApiBin()).resolves.toBe(join(root, "packages", "api", "dist", "bin.js"));
  });

  // Same identity check as dockerBuildContext(): a CLI vendored into someone
  // else's node_modules must not claim their tree's packages/api as ours.
  it("refuses the checkout fallback under node_modules even with every marker present", async () => {
    moduleFileOverride = "/home/u/proj/node_modules/@grounded/cli/dist/util/service.js";
    const { resolveApiBin } = await loadService({ GROUNDED_HOME: CAB });
    execOut = () => null;
    const guess = "/home/u/proj/node_modules";
    existing = new Set([
      ...["Dockerfile", "packages", "pnpm-workspace.yaml"].map((m) => join(guess, m)),
      join(guess, "packages", "api", "dist", "bin.js"),
    ]);
    await expect(resolveApiBin()).rejects.toThrow(/cannot locate a grounded-api entry point/);
  });

  it("the failure names every location tried and the ways out — never `npm i -g`", async () => {
    const { resolveApiBin } = await loadService({ GROUNDED_HOME: CAB });
    execOut = () => null;
    const err = await resolveApiBin().catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain("~/.grounded/lib/current/lib/api.mjs");
    expect(msg).toContain("grounded-api on PATH");
    expect(msg).toContain("packages/api/dist/bin.js");
    expect(msg).toContain("install.sh");
    expect(msg).toContain("GROUNDED_API_BIN=/path/to/api.mjs");
    expect(msg).toContain("--method docker");
    // \b keeps the legitimate `pnpm -r build` remedy from tripping this: npm as a
    // *package manager for @grounded/api* must never appear, because it cannot work.
    expect(msg).not.toMatch(/\bnpm\b/);
  });
});

describe("systemdExecStart", () => {
  it("prefixes JS entry points with this node and leaves executables alone", async () => {
    const { systemdExecStart } = await loadService();
    expect(systemdExecStart("/x/api.mjs")).toBe(`${process.execPath} /x/api.mjs`);
    expect(systemdExecStart("/x/bin.js")).toBe(`${process.execPath} /x/bin.js`);
    expect(systemdExecStart("/usr/local/bin/grounded-api")).toBe("/usr/local/bin/grounded-api");
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
