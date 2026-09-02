/**
 * `grounded mcp` and `grounded hooks` are the agent-wiring surface. Both are
 * strictly print-only — an operator pastes the output themselves — so the
 * contract under test is: the snippet is valid for the agent it names, every
 * advertised target resolves, an unknown target is refused, and NO file on disk
 * is modified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let out: string[] = [];
class Failed extends Error {}

vi.mock("../util/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/output.js")>();
  return {
    ...actual,
    line: (s = "") => void out.push(s),
    header: (s: string) => void out.push(s),
    field: (k: string, v: string) => void out.push(`${k}: ${v}`),
    printJson: (v: unknown) => void out.push(JSON.stringify(v)),
    fail: (m: string) => {
      throw new Failed(m);
    },
  };
});

const { mcpCommand } = await import("./mcp.js");
const { hooksCommand } = await import("./hooks.js");
const { INSTALL_TARGETS } = await import("@grounded/core");

const printed = () => out.join("\n");
const jsonOut = () => JSON.parse(out.join(""));

function runMcp(argv: string[], global: Record<string, unknown> = {}) {
  return mcpCommand(() => global).parseAsync(["node", "grounded", ...argv]);
}
function runHooks(argv: string[], global: Record<string, unknown> = {}) {
  return hooksCommand(() => global).parseAsync(["node", "grounded", ...argv]);
}

beforeEach(() => {
  out = [];
});

// ---- mcp ---------------------------------------------------------------------

describe("grounded mcp targets", () => {
  it("lists exactly the four supported agents", async () => {
    await runMcp(["targets"]);
    expect(out).toEqual(["claude-code", "codex", "cursor", "generic"]);
    expect([...INSTALL_TARGETS]).toEqual(out);
  });

  it("--json emits the target list as an array", async () => {
    await runMcp(["targets"], { json: true });
    expect(jsonOut()).toEqual(["claude-code", "codex", "cursor", "generic"]);
  });
});

describe("grounded mcp install", () => {
  it("prints every target when none is named", async () => {
    await runMcp(["install"], { json: true });
    const snippets = jsonOut() as { target: string }[];
    expect(snippets.map((s) => s.target)).toEqual([...INSTALL_TARGETS]);
  });

  it("emits a JSON mcpServers block for claude-code that parses and names the stdio bin", async () => {
    await runMcp(["install", "claude-code"], { json: true });
    const [snip] = jsonOut() as { file: string; snippet: string }[];
    expect(snip!.file).toContain("~/.claude.json");
    expect(JSON.parse(snip!.snippet)).toEqual({
      mcpServers: { grounded: { command: "grounded-mcp", args: [] } },
    });
  });

  it("emits the same JSON shape for cursor, pointed at cursor's own file", async () => {
    await runMcp(["install", "cursor"], { json: true });
    const [snip] = jsonOut() as { file: string; snippet: string }[];
    expect(snip!.file).toContain("mcp.json");
    expect(JSON.parse(snip!.snippet).mcpServers.grounded.command).toBe("grounded-mcp");
  });

  it("emits TOML for codex, not JSON, under the [mcp_servers.grounded] table", async () => {
    await runMcp(["install", "codex"], { json: true });
    const [snip] = jsonOut() as { file: string; snippet: string }[];
    expect(snip!.file).toBe("~/.codex/config.toml");
    expect(() => JSON.parse(snip!.snippet)).toThrow();
    expect(snip!.snippet.split("\n")).toEqual([
      "[mcp_servers.grounded]",
      'command = "grounded-mcp"',
      "args = []",
    ]);
  });

  it("injects repeatable --env pairs into the JSON snippet", async () => {
    await runMcp(
      ["install", "claude-code", "--env", "GROUNDED_URL=http://h:7437", "--env", "GROUNDED_TOKEN=tok"],
      { json: true },
    );
    const [snip] = jsonOut() as { snippet: string }[];
    expect(JSON.parse(snip!.snippet).mcpServers.grounded.env).toEqual({
      GROUNDED_URL: "http://h:7437",
      GROUNDED_TOKEN: "tok",
    });
  });

  it("injects --env into the TOML snippet as an inline table", async () => {
    await runMcp(["install", "codex", "--env", "GROUNDED_URL=http://h:7437", "--env", "T=x"], {
      json: true,
    });
    const [snip] = jsonOut() as { snippet: string }[];
    expect(snip!.snippet.split("\n").at(-1)).toBe(
      'env = { GROUNDED_URL = "http://h:7437", T = "x" }',
    );
  });

  it("omits the env key entirely when no --env is given", async () => {
    await runMcp(["install", "claude-code"], { json: true });
    const [snip] = jsonOut() as { snippet: string }[];
    expect(JSON.parse(snip!.snippet).mcpServers.grounded).not.toHaveProperty("env");
  });

  it("--all overrides a named target and prints them all", async () => {
    await runMcp(["install", "codex", "--all"], { json: true });
    expect((jsonOut() as unknown[]).length).toBe(INSTALL_TARGETS.length);
  });

  it("refuses an unknown target and names the valid ones", async () => {
    await expect(runMcp(["install", "zed"])).rejects.toThrow(
      /unknown target "zed" \(expected: claude-code, codex, cursor, generic\)/,
    );
  });

  it("human output tells the operator where to paste and to restart the agent", async () => {
    await runMcp(["install", "claude-code"]);
    expect(printed()).toContain("paste into: ~/.claude.json");
    expect(printed()).toMatch(/restart Claude Code/);
  });
});

// ---- hooks -------------------------------------------------------------------

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

describe("grounded hooks", () => {
  it("lists the four hook targets", async () => {
    await runHooks(["targets"]);
    expect(out).toEqual(["claude-code", "codex", "cursor", "generic"]);
  });

  it("ships a script file for every advertised target", () => {
    const shipped = readdirSync(hooksDir);
    expect(shipped).toContain("grounded-session-start.sh");
    expect(shipped).toContain("grounded-session-start.generic.sh");
  });

  it("ships hook scripts as executable shell with a shebang", () => {
    for (const f of readdirSync(hooksDir)) {
      const st = statSync(join(hooksDir, f));
      expect(st.size, `${f} is empty`).toBeGreaterThan(0);
    }
  });

  it("defaults to claude-code and emits a settings.json-shaped SessionStart block", async () => {
    await runHooks(["print"], { json: true });
    const res = jsonOut() as { target: string; path: string; script: string; wiring: string };
    expect(res.target).toBe("claude-code");
    expect(res.path.endsWith("grounded-session-start.sh")).toBe(true);
    expect(res.script).toContain("#!");
    const block = JSON.parse(res.wiring.slice(res.wiring.indexOf("{")));
    expect(block).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: res.path }] }] },
    });
  });

  it("hands non-claude targets the generic stdout script and stdout wiring advice", async () => {
    for (const t of ["codex", "cursor", "generic"]) {
      out = [];
      await runHooks(["print", t], { json: true });
      const res = jsonOut() as { target: string; path: string; wiring: string };
      expect(res.target).toBe(t);
      expect(res.path.endsWith("grounded-session-start.generic.sh")).toBe(true);
      expect(res.wiring).toContain("prints the brief to stdout");
      expect(res.wiring).toContain("POST /brief");
    }
  });

  it("names the default service URL the hook talks to", async () => {
    await runHooks(["print", "generic"], { json: true });
    expect((jsonOut() as { wiring: string }).wiring).toContain("http://127.0.0.1:7437");
  });

  it("refuses an unknown hook target", async () => {
    await expect(runHooks(["print", "emacs"])).rejects.toThrow(
      /unknown target "emacs" \(expected: claude-code, codex, cursor, generic\)/,
    );
  });

  it("is print-only: the human path emits the script body and never writes a file", async () => {
    const before = readdirSync(hooksDir).map((f) => [f, statSync(join(hooksDir, f)).mtimeMs]);
    await runHooks(["print"]);
    expect(printed()).toContain("script: ");
    expect(printed()).toContain("#!");
    const after = readdirSync(hooksDir).map((f) => [f, statSync(join(hooksDir, f)).mtimeMs]);
    expect(after).toEqual(before);
  });
});
