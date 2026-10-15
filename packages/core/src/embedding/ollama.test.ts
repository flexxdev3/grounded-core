import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config.js";
import { ConfigError } from "../contract.js";
import { createOllamaProvider } from "./ollama.js";

function cfgWith(device?: string) {
  const cfg = defaultConfig();
  (cfg.embeddings as { device?: string }).device = device;
  return cfg;
}

function captureBody(): { body: () => Record<string, unknown> } {
  let sent = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 });
    }),
  );
  return { body: () => JSON.parse(sent) };
}

describe("ollama device", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cpu sends num_gpu 0", async () => {
    const cap = captureBody();
    await createOllamaProvider(cfgWith("cpu")).embed(["x"]);
    expect(cap.body().options).toEqual({ num_gpu: 0 });
  });

  it("auto (default) sends no options", async () => {
    const cap = captureBody();
    await createOllamaProvider(cfgWith()).embed(["x"]);
    expect(cap.body().options).toBeUndefined();
  });

  it("rejects an unknown device", () => {
    expect(() => createOllamaProvider(cfgWith("gpu0"))).toThrow(ConfigError);
  });
});
