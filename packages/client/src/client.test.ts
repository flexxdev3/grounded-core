import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, openStore } from "@grounded/core";
import type { GroundedConfig, Store } from "@grounded/core/contract";
import { createApp } from "@grounded/api";
import { createClient, GroundedHttpError, type GroundedClient } from "./index.js";

function sqliteConfig(home: string): GroundedConfig {
  const cfg = defaultConfig(home);
  cfg.storage.adapter = "sqlite";
  cfg.storage.path = join(home, "grounded.db");
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 0;
  return cfg;
}

describe("@grounded/client against in-process createApp", () => {
  let home: string;
  let store: Store;
  let client: GroundedClient;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-client-"));
    store = await openStore(sqliteConfig(home));
    const app = createApp(store);
    // Route the client's fetch into the Hono app — no network, no port.
    const appFetch: typeof fetch = (input, init) =>
      app.fetch(new Request(input as string | URL, init as RequestInit));
    client = createClient({ baseUrl: "http://local.test", fetch: appFetch });
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("health round-trips", async () => {
    const h = await client.health();
    expect(h.storage.adapter).toBe("sqlite");
    expect(h.embeddings.provider).toBe("none");
  });

  it("facts add + list", async () => {
    const f = await client.facts.add({ fact: "Never push without instruction", pinned: true });
    expect(f.id).toBeGreaterThan(0);
    expect(f.pinned).toBe(true);
    const list = await client.facts.list();
    expect(list.some((x) => x.id === f.id)).toBe(true);
  });

  it("sessions add + list", async () => {
    const s = await client.sessions.add({ summary: "Set up the demo", project: "demo" });
    expect(s.summary).toBe("Set up the demo");
    const list = await client.sessions.list({ project: "demo" });
    expect(list.some((x) => x.id === s.id)).toBe(true);
  });

  it("sessions get by id", async () => {
    const s = await client.sessions.add({ summary: "Fetch me by id", project: "demo" });
    const got = await client.sessions.get(s.id);
    expect(got.id).toBe(s.id);
    expect(got.summary).toBe("Fetch me by id");
  });

  it("facts supersede then delete", async () => {
    const orig = await client.facts.add({ fact: "Recall budget is 500ms", topicKey: "recall-budget" });
    const next = await client.facts.supersede(orig.id, {
      fact: "Recall budget is 200ms",
      topicKey: "recall-budget",
    });
    expect(next.id).not.toBe(orig.id);
    expect(next.fact).toContain("200ms");
    const del = await client.facts.delete(next.id);
    expect(del.deleted).toBe(true);
    expect(del.id).toBe(next.id);
  });

  it("get resolves a typed id to a full record", async () => {
    const f = await client.facts.add({ fact: "Cite every retrieved answer" });
    const rec = await client.get(`fact:${f.id}`);
    expect(rec.sourceType).toBe("fact");
    if (rec.sourceType === "fact") expect(rec.record.id).toBe(f.id);
  });

  it("recall returns cited cards", async () => {
    const results = await client.recall("demo", { lexicalOnly: true });
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) expect(r.citation).toBeTruthy();
  });

  it("brief assembles context", async () => {
    const b = await client.brief({ project: "demo", format: "json" });
    expect(b.startupNote).toBeTruthy();
    expect(Array.isArray(b.facts)).toBe(true);
  });

  it("throws GroundedHttpError on a bad request", async () => {
    await expect(client.facts.add({ fact: "" })).rejects.toBeInstanceOf(GroundedHttpError);
  });
});
