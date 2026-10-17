/**
 * `grounded migrate-cabinet`: the service is stopped before the move and
 * brought back after it, a Docker install is recreated (its old mount points at
 * the old folder), and a refused move leaves the service on the old cabinet.
 * Runs the REAL move against a temp HOME; every service boundary is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const detect = vi.fn();
const startService = vi.fn();
const stopService = vi.fn();
const recreateDocker = vi.fn();
const inspectDockerService = vi.fn();
const healthPoll = vi.fn();
let out: string[] = [];

vi.mock("@grounded/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@grounded/core")>();
  return { ...actual, detect: (...a: unknown[]) => detect(...a) };
});
vi.mock("../util/service.js", () => ({
  startService: (...a: unknown[]) => startService(...a),
  stopService: (...a: unknown[]) => stopService(...a),
  recreateDocker: (...a: unknown[]) => recreateDocker(...a),
  inspectDockerService: (...a: unknown[]) => inspectDockerService(...a),
  healthPoll: (...a: unknown[]) => healthPoll(...a),
}));
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

const { migrateCabinetCommand, printCabinetNotice } = await import("./migrate.js");
const { purgeTargets } = await import("./service.js");

let root: string;
const sys = () => join(root, ".grounded");
const legacy = () => join(sys(), "cabinet");
const target = () => join(root, "Grounded", "Cabinet");
const printed = () => out.join("\n");
const run = () => migrateCabinetCommand(() => ({ home: sys() })).parseAsync(["node", "grounded", "-y"]);

beforeEach(() => {
  out = [];
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "grounded-cli-migrate-"));
  mkdirSync(join(legacy(), "docs"), { recursive: true });
  writeFileSync(join(legacy(), "grounded.db"), "db");
  detect.mockResolvedValue({ running: true, method: "systemd-user", health: { ok: true, port: 7437 }, evidence: [] });
  startService.mockResolvedValue(0);
  stopService.mockResolvedValue(0);
  healthPoll.mockResolvedValue(true);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("migrate-cabinet", () => {
  it("stops the service, moves the cabinet, restarts it", async () => {
    await run();
    expect(stopService).toHaveBeenCalledWith("systemd-user", sys());
    expect(startService).toHaveBeenCalledWith("systemd-user", sys());
    expect(stopService.mock.invocationCallOrder[0]).toBeLessThan(startService.mock.invocationCallOrder[0]!);
    expect(existsSync(join(target(), "grounded.db"))).toBe(true);
    expect(existsSync(legacy())).toBe(false);
    expect(printed()).toContain(`to ${target()}`);
  });

  it("recreates a Docker container with its image and token instead of restarting it", async () => {
    detect.mockResolvedValue({ running: true, method: "docker", health: { ok: true, port: 7500 }, evidence: [] });
    inspectDockerService.mockResolvedValue({ image: "grounded:latest", token: "t0k", mounts: [sys()] });
    await run();
    expect(recreateDocker).toHaveBeenCalledWith({ home: sys(), port: 7500, image: "grounded:latest", token: "t0k" });
    expect(startService).not.toHaveBeenCalled();
  });

  it("never touches a container that does not mount this home", async () => {
    detect.mockResolvedValue({ running: true, method: "docker", health: { ok: true, port: 7437 }, evidence: [] });
    inspectDockerService.mockResolvedValue({ image: "grounded:latest", mounts: ["/elsewhere/.grounded"] });
    await expect(run()).rejects.toThrow(/cannot be stopped from here/);
    expect(stopService).not.toHaveBeenCalled();
    expect(recreateDocker).not.toHaveBeenCalled();
  });

  it("refuses a non-empty target without stopping anything", async () => {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "x.md"), "x");
    await expect(run()).rejects.toThrow(/already holds files/);
    expect(stopService).not.toHaveBeenCalled();
    expect(existsSync(join(legacy(), "grounded.db"))).toBe(true);
  });

  it("refuses to run under a service it cannot stop", async () => {
    detect.mockResolvedValue({ running: true, method: "process", evidence: [] });
    await expect(run()).rejects.toThrow(/cannot be stopped from here/);
    expect(existsSync(join(legacy(), "grounded.db"))).toBe(true);
  });

  it("says there is nothing to do once migrated", async () => {
    await run();
    out = [];
    await run();
    expect(printed()).toMatch(/nothing to migrate/);
  });
});

describe("cabinet notice + purge targets", () => {
  it("status names a legacy cabinet and the command that moves it", () => {
    printCabinetNotice(sys());
    expect(printed()).toContain(`legacy location ${legacy()}`);
    expect(printed()).toContain("grounded migrate-cabinet");
  });

  it("is silent for the normal layout", () => {
    rmSync(legacy(), { recursive: true });
    printCabinetNotice(sys());
    expect(printed()).toBe("");
  });

  it("purges both ~/Grounded and ~/.grounded by default, one folder otherwise", () => {
    expect(purgeTargets(sys())).toEqual([sys()]); // legacy: cabinet is inside the home
    rmSync(legacy(), { recursive: true });
    expect(purgeTargets(sys())).toEqual([join(root, "Grounded"), sys()]);
    expect(purgeTargets(join(root, "custom"))).toEqual([join(root, "custom")]);
    expect(purgeTargets(join(root, "Grounded", ".core"))).toEqual([join(root, "Grounded")]);
  });
});
