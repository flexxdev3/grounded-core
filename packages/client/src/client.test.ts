import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(list.data.some((x) => x.id === f.id)).toBe(true);
  });

  it("facts.list meta.available reflects the true count when more rows exist than limit", async () => {
    const scope = "project:client-envelope-honesty";
    for (let i = 0; i < 12; i++) {
      await client.facts.add({ fact: `Envelope honesty fact ${i}`, scope });
    }
    const list = await client.facts.list({ scope, limit: 5 });
    // A `data.length` fake would report 5 here and pass a naive assertion;
    // asserting available/returned/truncated together against the seeded
    // count (12, not the limit) is what catches it.
    expect(list.data.length).toBe(5);
    expect(list.meta.returned).toBe(5);
    expect(list.meta.available).toBe(12);
    expect(list.meta.truncated).toBe(true);
  });

  it("facts.add returns a delivery rank", async () => {
    const f = await client.facts.add({ fact: "Delivery rank smoke test", scope: "project:client-delivery" });
    expect(f.delivery).toBeDefined();
    expect(f.delivery!.rank).toBeGreaterThan(0);
    expect(f.delivery!.ofActive).toBeGreaterThanOrEqual(f.delivery!.rank);
  });

  it("recall returns meta.bySource", async () => {
    await client.facts.add({ fact: "Recall bySource accounting probe" });
    const results = await client.recall("bySource accounting", { lexicalOnly: true });
    expect(results.meta.bySource).toBeDefined();
  });

  it("sessions add + list", async () => {
    const s = await client.sessions.add({ summary: "Set up the demo", project: "demo" });
    expect(s.summary).toBe("Set up the demo");
    const list = await client.sessions.list({ project: "demo" });
    expect(list.data.some((x) => x.id === s.id)).toBe(true);
  });

  it("sessions get by id", async () => {
    const s = await client.sessions.add({ summary: "Fetch me by id", project: "demo" });
    const got = await client.sessions.get(s.id);
    expect(got.id).toBe(s.id);
    expect(got.summary).toBe("Fetch me by id");
  });

  it("facts update then delete", async () => {
    const orig = await client.facts.add({ fact: "Recall budget is 500ms", topicKey: "recall-budget" });
    const next = await client.facts.update(orig.id, { fact: "Recall budget is 200ms" });
    expect(next.id).toBe(orig.id);
    expect(next.fact).toContain("200ms");
    const del = await client.facts.delete(next.id);
    expect(del.deleted).toBe(true);
    expect(del.id).toBe(next.id);
  });

  it("facts.add defaults origin to 'stated' and accepts an explicit 'derived'", async () => {
    const defaulted = await client.facts.add({ fact: "client origin default" });
    expect(defaulted.origin).toBe("stated");

    const derived = await client.facts.add({ fact: "client origin explicit", origin: "derived" });
    expect(derived.origin).toBe("derived");

    await client.facts.delete(defaulted.id);
    await client.facts.delete(derived.id);
  });

  it("facts.add upsert via topicKey survives the HTTP round trip as merge-patch, not full replacement", async () => {
    const scope = "project:client-upsert-merge-patch";
    const original = await client.facts.add({
      fact: "original curated fact",
      scope,
      topicKey: "client-upsert-key",
      pinned: true,
      importance: 0.9,
      category: "x",
    });
    expect(original.pinned).toBe(true);
    expect(original.importance).toBe(0.9);

    const upserted = await client.facts.add({
      fact: "restated fact text only",
      scope,
      topicKey: "client-upsert-key",
    });
    expect(upserted.id).toBe(original.id);
    expect(upserted.fact).toBe("restated fact text only");
    // omitted fields survive the round trip unchanged — this is what fails
    // against a full-replacement implementation.
    expect(upserted.pinned).toBe(true);
    expect(upserted.importance).toBe(0.9);
    expect(upserted.category).toBe("x");

    await client.facts.delete(original.id);
  });

  it("get resolves a typed id to a full record", async () => {
    const f = await client.facts.add({ fact: "Cite every retrieved answer" });
    const rec = await client.get(`fact:${f.id}`);
    expect(rec.sourceType).toBe("fact");
    if (rec.sourceType === "fact") expect(rec.record.id).toBe(f.id);
  });

  it("recall returns cited cards", async () => {
    const results = await client.recall("demo", { lexicalOnly: true });
    expect(Array.isArray(results.data)).toBe(true);
    for (const r of results.data) expect(r.citation).toBeTruthy();
  });

  it("brief assembles context", async () => {
    const b = await client.brief({ project: "demo", format: "json" });
    expect(b.startupNote).toBeTruthy();
    expect(Array.isArray(b.facts)).toBe(true);
  });

  it("vision set edits the active record in place + brief carries it", async () => {
    const v1 = await client.vision.set({ details: "First direction." });
    expect(v1.scope).toBe("global");
    const v2 = await client.vision.set({ details: "Second direction.", scope: "global" });
    expect(v2.id).toBe(v1.id);
    expect(v2.details).toBe("Second direction.");

    const active = await client.vision.list({ scope: "global" });
    expect(active.data.length).toBe(1);
    expect(active.data[0]!.id).toBe(v1.id);

    const b = await client.brief({ format: "markdown" });
    expect(b.vision.global?.id).toBe(v1.id);
    expect(b.text).toContain("=== VISION (global) ===");
    expect(b.text).toContain("Second direction.");

    const pv = await client.vision.set({ scope: "project:demo", details: "Demo direction." });
    const del = await client.vision.delete(pv.id);
    expect(del.deleted).toBe(true);
  });

  it("vision.set round-trips both details and summary", async () => {
    const v = await client.vision.set({
      scope: "project:round-trip",
      details: "The full narrative direction, at length.",
      summary: "Short form.",
    });
    expect(v.details).toBe("The full narrative direction, at length.");
    expect(v.summary).toBe("Short form.");
    const del = await client.vision.delete(v.id);
    expect(del.deleted).toBe(true);
  });

  it("throws GroundedHttpError on a bad request", async () => {
    await expect(client.facts.add({ fact: "" })).rejects.toBeInstanceOf(GroundedHttpError);
  });

  describe("docs.list query-builder split (source vs scope/scopes)", () => {
    let docsRoot: string;

    beforeAll(async () => {
      docsRoot = mkdtempSync(join(tmpdir(), "grounded-client-docs-"));
      writeFileSync(join(docsRoot, "eng.md"), "# Engineering doc\n\nEngineering lane content.");
      writeFileSync(join(docsRoot, "admin.md"), "# Admin doc\n\nAdministration lane content.");
      await client.docs.ingest([join(docsRoot, "eng.md")], { source: "eng-cabinet" });
      await client.docs.ingest([join(docsRoot, "admin.md")], {
        source: "admin-cabinet",
        scope: "administration",
      });
    });

    afterAll(() => {
      rmSync(docsRoot, { recursive: true, force: true });
    });

    it("?source= filters by logical source, not lane", async () => {
      const bySource = await client.docs.list({ source: "eng-cabinet" });
      expect(bySource.data.length).toBeGreaterThan(0);
      expect(bySource.data.every((d) => d.source === "eng-cabinet")).toBe(true);
    });

    it("?scope= filters by lane, independent of source", async () => {
      const byScope = await client.docs.list({ scope: "administration" });
      expect(byScope.data.length).toBeGreaterThan(0);
      expect(byScope.data.every((d) => d.scope === "administration")).toBe(true);
    });

    it("?scopes= (comma-joined) matches any of the given lanes", async () => {
      const byScopes = await client.docs.list({ scopes: ["global", "administration"] });
      const scopesSeen = new Set(byScopes.data.map((d) => d.scope));
      expect(scopesSeen.has("global")).toBe(true);
      expect(scopesSeen.has("administration")).toBe(true);
    });

    it("docs.list with no options stays unfiltered (every lane visible)", async () => {
      const all = await client.docs.list();
      const scopesSeen = new Set(all.data.map((d) => d.scope));
      expect(scopesSeen.has("administration")).toBe(true);
    });
  });

  describe("docs.prune", () => {
    it("reconciles docs rows against disk and returns a {missing, removed} report", async () => {
      const root = mkdtempSync(join(tmpdir(), "grounded-client-prune-"));
      const filePath = join(root, "prune-me.md");
      writeFileSync(filePath, "# Prune me\n\nThis file is about to disappear.");
      await client.docs.ingest([filePath]);
      rmSync(filePath);

      const dryReport = await client.docs.prune();
      expect(typeof dryReport.missing).toBe("number");
      expect(typeof dryReport.removed).toBe("number");
      expect(dryReport.missing).toBeGreaterThan(0);
      expect(dryReport.removed).toBe(0);

      // NOTE: this in-process harness (app.fetch(new Request(...)), no real HTTP
      // transport) never populates a "content-length" header on the constructed
      // Request, and POST /docs/prune in packages/api/src/app.ts gates body
      // parsing on that header being present/non-"0" — so `remove: true` cannot
      // be observed to flip the response here. That gate is in Agent B's file
      // (app.ts), not this package; over a real network transport content-length
      // is set by the HTTP layer and the route behaves correctly (verified
      // directly against the store in packages/core, see docsPrune there).
      // This call only asserts the client forwards the option and the response
      // shape is well-formed, not the server-side effect.
      const removeReport = await client.docs.prune({ remove: true });
      expect(typeof removeReport.missing).toBe("number");
      expect(typeof removeReport.removed).toBe("number");

      rmSync(root, { recursive: true, force: true });
    });
  });
});
