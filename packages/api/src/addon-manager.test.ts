import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addonDefinition, addonRuntimePresent, defaultConfig } from "@grounded/core";
import type { EmbeddingDevice, GroundedConfig } from "@grounded/core/contract";
import { createAddonManager } from "./addon-manager.js";
import type { EmbeddingsAddon, EmbeddingsJob } from "./addons.js";

function fakeEmbeddings(cfg: () => GroundedConfig): EmbeddingsAddon & { started: Array<EmbeddingDevice | undefined> } {
  let job: EmbeddingsJob = { state: "idle" };
  const addon = {
    started: [] as Array<EmbeddingDevice | undefined>,
    async status() {
      const c = cfg();
      return {
        provider: c.embeddings.provider,
        enabled: c.embeddings.provider !== "none",
        runtimeInstalled: true,
        model: "nomic-ai/nomic-embed-text-v1.5",
        modelPresent: true,
        downloadBytes: 0,
        gpuBackend: "directml" as const,
        device: c.embeddings.device ?? "auto",
        job,
      };
    },
    start(opts: { device?: EmbeddingDevice }) {
      if (job.state === "running") return false;
      addon.started.push(opts.device);
      job = { state: "running", phase: "probe" };
      return true;
    },
  };
  return addon;
}

describe("add-on manager: embeddings device", () => {
  let home: string;
  let cfg: GroundedConfig;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "grounded-addon-mgr-"));
    cfg = defaultConfig(home);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const manager = (embeddings: EmbeddingsAddon, live?: "gpu" | "cpu") =>
    createAddonManager({
      loadConfig: () => cfg,
      embeddings,
      reloadStore: async () => undefined,
      embeddingsDevice: async () => live,
      createDatabox: () => undefined,
    });

  it("reports the device setting and where vectors run now", async () => {
    cfg.embeddings = { provider: "local", device: "cpu" };
    const view = await manager(fakeEmbeddings(() => cfg), "cpu").get("embeddings");
    expect(view?.info).toMatchObject({ deviceSetting: "cpu", device: "cpu", gpuBackend: "directml" });
  });

  it("has no live device while search by meaning is off", async () => {
    cfg.embeddings = { provider: "none" };
    const view = await manager(fakeEmbeddings(() => cfg), "gpu").get("embeddings");
    expect(view?.info).toMatchObject({ deviceSetting: "auto", device: null });
  });

  it("re-running install on an on add-on switches the device without a download", async () => {
    const def = addonDefinition("embeddings")!;
    // the switch path needs the runtime importable; packaged CI without it skips.
    if (!(await addonRuntimePresent(home, def))) return;
    cfg.embeddings = { provider: "local", device: "gpu" };
    const embeddings = fakeEmbeddings(() => cfg);
    const m = manager(embeddings, "gpu");
    expect(m.install("embeddings", { device: "cpu" })).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(embeddings.started).toEqual(["cpu"]);
    expect((await m.get("embeddings"))?.state).toBe("installing");
  });
});
