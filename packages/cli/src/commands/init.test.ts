/**
 * `grounded init` materializes the cabinet. This runs the REAL bootstrap against
 * a throwaway temp dir — never the operator's ~/.grounded — because the property
 * that matters (a portable config.toml that does not pin the cabinet to one
 * absolute path) can only be observed on a written file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let out: string[] = [];
class Failed extends Error {}

vi.mock("../util/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/output.js")>();
  return {
    ...actual,
    line: (s = "") => void out.push(s),
    printJson: (v: unknown) => void out.push(JSON.stringify(v)),
    fail: (m: string) => {
      throw new Failed(m);
    },
  };
});

const { initCommand } = await import("./init.js");

let home: string;
const savedEnv = process.env.GROUNDED_HOME;

function runInit(global: Record<string, unknown> = {}) {
  return initCommand(() => global).parseAsync(["node", "grounded"]);
}
const result = () => JSON.parse(out.join("")) as { home: string; configPath: string; wroteConfig: boolean; migrated: boolean };

beforeEach(() => {
  out = [];
  home = mkdtempSync(join(tmpdir(), "grounded-init-"));
  delete process.env.GROUNDED_HOME;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.GROUNDED_HOME;
  else process.env.GROUNDED_HOME = savedEnv;
});

describe("grounded init", () => {
  it("creates the full cabinet tree and reports it as newly written", async () => {
    await runInit({ home, json: true });
    const r = result();
    expect(r.home).toBe(home);
    expect(r.wroteConfig).toBe(true);
    expect(r.migrated).toBe(true);
    for (const dir of ["facts", "sessions", "docs", "briefs", "exports", "backups"]) {
      expect(existsSync(join(home, "cabinet", dir)), `cabinet/${dir}`).toBe(true);
    }
    expect(existsSync(join(home, "logs"))).toBe(true);
    expect(existsSync(join(home, "mcp"))).toBe(true);
    expect(existsSync(join(home, "config.toml"))).toBe(true);
  });

  it("writes a portable config.toml — no absolute cabinet path is baked in", async () => {
    await runInit({ home, json: true });
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    // The whole point of the portability rule: relocating the cabinet must not
    // break it, so the resolved-at-load paths are never persisted.
    expect(toml).not.toContain(home);
    expect(toml).not.toContain(homedir());
    expect(toml).not.toMatch(/^path\s*=/m);
  });

  it("writes defaults for every config section the engine reads", async () => {
    await runInit({ home, json: true });
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    for (const section of ["[storage]", "[embeddings]", "[recall]", "[recall.sourceCaps]", "[recall.boosts]", "[ingest]"]) {
      expect(toml, section).toContain(section);
    }
    // zero-service default: sqlite, so a stranger's laptop needs no infrastructure
    expect(toml).toMatch(/adapter = "sqlite"/);
    expect(toml).toMatch(/rrfK = 60/); // the pinned RRF constant
    expect(toml).toMatch(/stripPrivate = true/);
    expect(toml).toMatch(/ignoreFile = "\.groundignore"/);
  });

  it("is idempotent and never clobbers an operator-edited config", async () => {
    await runInit({ home, json: true });
    const edited = readFileSync(join(home, "config.toml"), "utf8") + '\n# operator note\n';
    writeFileSync(join(home, "config.toml"), edited, "utf8");

    out = [];
    await runInit({ home, json: true });
    expect(result().wroteConfig).toBe(false);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(edited);
  });

  it("falls back to GROUNDED_HOME when --home is absent", async () => {
    process.env.GROUNDED_HOME = home;
    await runInit({ json: true });
    expect(result().home).toBe(home);
  });

  it("human output names the cabinet and whether config was written", async () => {
    await runInit({ home });
    expect(out.join("\n")).toContain(`cabinet ready at ${home}`);
    expect(out.join("\n")).toContain(`wrote ${join(home, "config.toml")}`);
    out = [];
    await runInit({ home });
    expect(out.join("\n")).toContain(`config exists: ${join(home, "config.toml")}`);
  });

  it("reports a bootstrap failure instead of throwing through the CLI", async () => {
    // a path under a regular file can never be created
    const blocker = join(home, "blocker");
    writeFileSync(blocker, "not a dir", "utf8");
    await expect(runInit({ home: join(blocker, "cab") })).rejects.toBeInstanceOf(Failed);
  });
});
