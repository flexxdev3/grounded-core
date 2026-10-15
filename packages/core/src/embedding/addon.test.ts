import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { defaultConfig } from "../config.js";
import { embeddingsAddonPlan, writeEmbeddingsConfig } from "./addon.js";

const SAMPLE = `[storage]
adapter = "sqlite"

[embeddings]
provider = "none"

# keep me
[recall]
rrfK = 60
`;

describe("embeddings add-on", () => {
  it("rewrites only the [embeddings] table", () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-addon-"));
    writeFileSync(join(home, "config.toml"), SAMPLE);
    writeEmbeddingsConfig(home, { provider: "local", device: "auto" });
    const out = readFileSync(join(home, "config.toml"), "utf8");
    const toml = parse(out) as Record<string, Record<string, unknown>>;
    expect(toml.embeddings).toEqual({ provider: "local", device: "auto" });
    expect(toml.recall!.rrfK).toBe(60);
    expect(toml.storage!.adapter).toBe("sqlite");
    expect(out).toContain("# keep me");
  });

  it("is stable when run twice (its own comment does not split the table)", () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-addon-"));
    writeFileSync(join(home, "config.toml"), SAMPLE);
    writeEmbeddingsConfig(home, { provider: "local", device: "auto" });
    const once = readFileSync(join(home, "config.toml"), "utf8");
    writeEmbeddingsConfig(home, { provider: "local", device: "auto" });
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(once);
    writeEmbeddingsConfig(home, { provider: "none" });
    const toml = parse(readFileSync(join(home, "config.toml"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(toml.embeddings).toEqual({ provider: "none" });
  });

  it("appends the table when the file has none", () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-addon-"));
    writeFileSync(join(home, "config.toml"), `[storage]\nadapter = "sqlite"\n`);
    writeEmbeddingsConfig(home, { provider: "local" });
    const toml = parse(readFileSync(join(home, "config.toml"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(toml.embeddings).toEqual({ provider: "local" });
  });

  it("plans a download for a lexical-only cabinet", async () => {
    const cfg = defaultConfig(mkdtempSync(join(tmpdir(), "grounded-addon-")));
    cfg.embeddings = { provider: "none" };
    const plan = await embeddingsAddonPlan(cfg);
    expect(plan.enabled).toBe(false);
    expect(plan.modelPresent).toBe(false);
    expect(plan.downloadBytes).toBeGreaterThan(100_000_000);
    expect(plan.model).toBe("nomic-ai/nomic-embed-text-v1.5");
  });
});
