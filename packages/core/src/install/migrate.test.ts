import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cabinetDir, cabinetLayout } from "../config.js";
import { migrateCabinet, planCabinetMigration, CabinetMigrationError } from "./migrate.js";

let root: string;
const sys = () => join(root, ".grounded");
const legacy = () => join(root, ".grounded", "cabinet");
const target = () => join(root, "Grounded", "Cabinet");

function seedLegacy(): void {
  mkdirSync(join(legacy(), "docs"), { recursive: true });
  mkdirSync(join(legacy(), "backups"), { recursive: true });
  writeFileSync(join(legacy(), "grounded.db"), Buffer.alloc(4096, 7));
  writeFileSync(join(legacy(), "grounded.db-wal"), "wal");
  writeFileSync(join(legacy(), "docs", "note.md"), "# hi");
  writeFileSync(join(sys(), "config.toml"), '[storage]\nadapter = "sqlite"\n');
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof CabinetMigrationError ? err.code : "other";
  }
  return undefined;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grounded-migrate-"));
  mkdirSync(sys(), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("planCabinetMigration", () => {
  it("refuses a custom home", () => {
    expect(codeOf(() => planCabinetMigration(join(root, "custom")))).toBe("NOT_DEFAULT_HOME");
  });

  it("has nothing to do when the legacy folder holds no files", () => {
    mkdirSync(join(legacy(), "docs"), { recursive: true });
    expect(codeOf(() => planCabinetMigration(sys()))).toBe("NOTHING_TO_MIGRATE");
  });

  it("refuses when the target already holds files", () => {
    seedLegacy();
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "x.md"), "x");
    expect(codeOf(() => planCabinetMigration(sys()))).toBe("TARGET_NOT_EMPTY");
  });

  it("refuses when config.toml pins storage.path inside the legacy cabinet", () => {
    seedLegacy();
    writeFileSync(join(sys(), "config.toml"), `[storage]\npath = ${JSON.stringify(join(legacy(), "grounded.db"))}\n`);
    expect(codeOf(() => planCabinetMigration(sys()))).toBe("PINNED_STORAGE_PATH");
  });

  it("plans legacy -> ~/Grounded/Cabinet", () => {
    seedLegacy();
    expect(planCabinetMigration(sys())).toEqual({ from: legacy(), to: target() });
  });
});

describe("migrateCabinet", () => {
  it("renames the legacy cabinet into place (same filesystem) and the layout flips to visible", async () => {
    seedLegacy();
    mkdirSync(join(target(), "docs"), { recursive: true }); // empty skeleton is fine
    expect(cabinetDir(sys())).toBe(legacy());
    const res = await migrateCabinet(sys());
    expect(res).toMatchObject({ from: legacy(), to: target(), method: "rename", files: 3 });
    expect(existsSync(legacy())).toBe(false);
    expect(readFileSync(join(target(), "docs", "note.md"), "utf8")).toBe("# hi");
    expect(existsSync(join(target(), "backups"))).toBe(true);
    expect(cabinetLayout(sys())).toMatchObject({ dir: target(), kind: "visible", leftover: null });
    expect(existsSync(join(sys(), "config.toml"))).toBe(true);
  });

  it("copies, verifies, then removes the source across filesystems", async () => {
    seedLegacy();
    const res = await migrateCabinet(sys(), {
      rename: () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      },
    });
    expect(res.method).toBe("copy");
    expect(res.files).toBe(3);
    expect(existsSync(legacy())).toBe(false);
    expect(readFileSync(join(target(), "grounded.db")).length).toBe(4096);
  });

  it("leaves everything in place when refused", async () => {
    seedLegacy();
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "x.md"), "x");
    await expect(migrateCabinet(sys())).rejects.toThrow(/already holds files/);
    expect(existsSync(join(legacy(), "grounded.db"))).toBe(true);
    expect(readFileSync(join(target(), "x.md"), "utf8")).toBe("x");
  });
});
