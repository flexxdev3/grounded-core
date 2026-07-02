import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installSnippet, INSTALL_TARGETS, type InstallTarget } from "./config.js";

// repo root: packages/core/src/install → ../../../..
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const configsDir = join(repoRoot, "examples", "configs");

const FILES: Record<InstallTarget, string> = {
  "claude-code": "claude-code.mcp.json",
  cursor: "cursor.mcp.json",
  codex: "codex.config.toml",
  generic: "generic.mcp.json",
};

describe("install config examples", () => {
  it("ships a checked-in example for every target", () => {
    expect(Object.keys(FILES).sort()).toEqual([...INSTALL_TARGETS].sort());
  });

  for (const target of INSTALL_TARGETS) {
    it(`examples/configs/${FILES[target]} matches installSnippet("${target}")`, () => {
      const onDisk = readFileSync(join(configsDir, FILES[target]), "utf8").trimEnd();
      expect(onDisk).toBe(installSnippet(target).snippet);
    });
  }
});
