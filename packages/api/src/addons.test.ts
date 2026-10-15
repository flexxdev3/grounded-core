import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, openStore } from "@grounded/core";
import type { Store } from "@grounded/core/contract";
import { createApp } from "./app.js";
import type { EmbeddingsAddon, EmbeddingsJob } from "./addons.js";

function fakeAddon(): EmbeddingsAddon & { starts: number } {
  let job: EmbeddingsJob = { state: "idle" };
  const addon = {
    starts: 0,
    async status() {
      return {
        provider: "none",
        enabled: false,
        runtimeInstalled: true,
        model: "nomic-ai/nomic-embed-text-v1.5",
        modelPresent: false,
        downloadBytes: 274_000_000,
        gpuBackend: null,
        job,
      };
    },
    start() {
      if (job.state === "running") return false;
      addon.starts++;
      job = { state: "running", phase: "download" };
      return true;
    },
  };
  return addon;
}

describe("/addons/embeddings", () => {
  let home: string;
  let store: Store;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-addon-api-"));
    const cfg = defaultConfig(home);
    cfg.embeddings = { provider: "none" };
    store = await openStore(cfg);
    await store.init();
  });
  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("is 404 when the host has no add-on", async () => {
    const res = await createApp(store).request("/addons/embeddings");
    expect(res.status).toBe(404);
  });

  it("reports the plan, starts once, and refuses a second start while running", async () => {
    const addon = fakeAddon();
    const app = createApp(store, { embeddingsAddon: addon });
    const plan = (await (await app.request("/addons/embeddings")).json()) as { data: { downloadBytes: number; job: EmbeddingsJob } };
    expect(plan.data.downloadBytes).toBe(274_000_000);
    expect(plan.data.job.state).toBe("idle");

    const first = await app.request("/addons/embeddings", { method: "POST", body: "{}" });
    expect(first.status).toBe(202);
    const second = await app.request("/addons/embeddings", { method: "POST", body: "{}" });
    expect(second.status).toBe(409);
    expect(addon.starts).toBe(1);
  });

  it("validates device", async () => {
    const app = createApp(store, { embeddingsAddon: fakeAddon() });
    const res = await app.request("/addons/embeddings", { method: "POST", body: JSON.stringify({ device: "tpu" }) });
    expect(res.status).toBe(400);
  });
});
