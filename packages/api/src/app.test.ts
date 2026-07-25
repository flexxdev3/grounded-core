import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, openStore } from "@grounded/core";
import type { GroundedConfig, Store } from "@grounded/core/contract";
import { createApp } from "./app.js";

function sqliteConfig(home: string): GroundedConfig {
  const cfg = defaultConfig(home);
  cfg.storage.adapter = "sqlite";
  cfg.storage.path = join(home, "grounded.db");
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 0;
  return cfg;
}

describe("@grounded/api fact status", () => {
  let home: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-api-"));
    store = await openStore(sqliteConfig(home));
    app = createApp(store);
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://local.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function patch(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://local.test${path}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function get(path: string): Promise<Response> {
    return app.fetch(new Request(`http://local.test${path}`));
  }

  it("rejects an invalid status on POST /facts and stores nothing", async () => {
    const before = await (await get("/facts?status=all")).json();
    const res = await post("/facts", { fact: "bogus status fact", status: "bogus" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    const after = await (await get("/facts?status=all")).json();
    expect(after.data.length).toBe(before.data.length);
  });

  it("stores a fact created with status=archived", async () => {
    const res = await post("/facts", { fact: "created archived", status: "archived" });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.status).toBe("archived");
  });

  it("PATCH status=archived hides from default GET /facts but shows under archived/all", async () => {
    const created = await (await post("/facts", { fact: "will be archived" })).json();
    expect(created.status).toBe("active");

    const patched = await patch(`/facts/${created.id}`, { status: "archived" });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.status).toBe("archived");

    const defaultList = await (await get("/facts")).json();
    expect(defaultList.data.some((f: { id: number }) => f.id === created.id)).toBe(false);

    const archivedList = await (await get("/facts?status=archived")).json();
    expect(archivedList.data.some((f: { id: number }) => f.id === created.id)).toBe(true);

    const allList = await (await get("/facts?status=all")).json();
    expect(allList.data.some((f: { id: number }) => f.id === created.id)).toBe(true);
  });

  it("defaults importance to 0.6 when not provided", async () => {
    const res = await post("/facts", { fact: "no importance given" });
    const created = await res.json();
    expect(created.importance).toBe(0.6);
  });

  it("rejects an invalid status query on GET /facts", async () => {
    const res = await get("/facts?status=bogus");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("defaults origin to 'stated' on POST /facts, and accepts an explicit 'derived'", async () => {
    const defaulted = await (await post("/facts", { fact: "no origin given" })).json();
    expect(defaulted.origin).toBe("stated");

    const derived = await (
      await post("/facts", { fact: "explicitly derived", origin: "derived" })
    ).json();
    expect(derived.origin).toBe("derived");
  });

  it("rejects an invalid origin on POST /facts and stores nothing", async () => {
    const before = await (await get("/facts?status=all")).json();
    const res = await post("/facts", { fact: "bogus origin fact", origin: "guessed" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    const after = await (await get("/facts?status=all")).json();
    expect(after.data.length).toBe(before.data.length);
  });

  it("PATCH accepts an explicit origin change and rejects an invalid one", async () => {
    const created = await (await post("/facts", { fact: "origin patch target" })).json();
    expect(created.origin).toBe("stated");

    const patched = await patch(`/facts/${created.id}`, { origin: "derived" });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.origin).toBe("derived");

    const rejected = await patch(`/facts/${created.id}`, { origin: "bogus" });
    expect(rejected.status).toBe(400);
    const rejectedBody = await rejected.json();
    expect(rejectedBody.code).toBe("VALIDATION_ERROR");

    // the invalid PATCH must not have half-applied.
    const unchanged = await (await get(`/facts?status=all`)).json();
    const stillDerived = unchanged.data.find((f: { id: number }) => f.id === created.id);
    expect(stillDerived.origin).toBe("derived");
  });
});

describe("@grounded/api docs scope/source", () => {
  let home: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-api-docs-"));
    store = await openStore(sqliteConfig(home));
    app = createApp(store);
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://local.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function get(path: string): Promise<Response> {
    return app.fetch(new Request(`http://local.test${path}`));
  }

  it("POST /docs/prune returns a report with missing and removed counts", async () => {
    const res = await post("/docs/prune", { remove: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.missing).toBe("number");
    expect(typeof body.removed).toBe("number");
  });

  it("POST /docs/prune defaults remove to false when the body is omitted", async () => {
    const res = await app.fetch(new Request("http://local.test/docs/prune", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.missing).toBe("number");
    expect(typeof body.removed).toBe("number");
  });

  it("POST /docs/prune honors a body sent without a content-length header", async () => {
    // Regression: the route used to gate body parsing on `content-length`, which is
    // absent on chunked transfer-encoding requests — the body was silently dropped
    // and `remove` fell back to false with a 200 and no signal. Same gate was on
    // /brief, where it would have silently discarded docScopes/factScopes.
    const calls: unknown[] = [];
    const originalPrune = store.docsPrune.bind(store);
    store.docsPrune = (async (opts) => {
      calls.push(opts);
      return originalPrune(opts);
    }) as typeof store.docsPrune;
    try {
      const res = await app.fetch(
        new Request("http://local.test/docs/prune", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remove: true }),
        }),
      );
      expect(res.status).toBe(200);
      expect(calls.length).toBe(1);
      expect((calls[0] as Record<string, unknown>).remove).toBe(true);
    } finally {
      store.docsPrune = originalPrune;
    }
  });

  it("POST /brief honors a body sent without a content-length header", async () => {
    const calls: unknown[] = [];
    const originalBrief = store.brief.bind(store);
    store.brief = (async (opts) => {
      calls.push(opts);
      return originalBrief(opts);
    }) as typeof store.brief;
    try {
      const res = await app.fetch(
        new Request("http://local.test/brief", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docScopes: ["global", "administration"] }),
        }),
      );
      expect(res.status).toBe(200);
      expect(calls.length).toBe(1);
      expect((calls[0] as Record<string, unknown>).docScopes).toEqual([
        "global",
        "administration",
      ]);
    } finally {
      store.brief = originalBrief;
    }
  });

  it("GET /docs maps ?source= to opts.source, not opts.scope (clean break)", async () => {
    const calls: unknown[] = [];
    const originalDocsList = store.docsList.bind(store);
    store.docsList = (async (opts) => {
      calls.push(opts);
      return originalDocsList(opts);
    }) as typeof store.docsList;
    try {
      await get("/docs?source=homelab&scope=global&scopes=global,administration");
      expect(calls.length).toBe(1);
      const opts = calls[0] as Record<string, unknown>;
      expect(opts.source).toBe("homelab");
      expect(opts.scope).toBe("global");
      expect(opts.scopes).toEqual(["global", "administration"]);
    } finally {
      store.docsList = originalDocsList;
    }
  });

  it("POST /recall forwards scopes to the store", async () => {
    const calls: unknown[] = [];
    const originalRecall = store.recall.bind(store);
    store.recall = (async (query, opts) => {
      calls.push(opts);
      return originalRecall(query, opts);
    }) as typeof store.recall;
    try {
      const res = await post("/recall", {
        query: "test",
        scopes: ["global", "administration"],
      });
      expect(res.status).toBe(200);
      expect(calls.length).toBe(1);
      const opts = calls[0] as Record<string, unknown>;
      expect(opts.scopes).toEqual(["global", "administration"]);
    } finally {
      store.recall = originalRecall;
    }
  });
});

describe("@grounded/api delivery envelope", () => {
  let home: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-api-delivery-"));
    store = await openStore(sqliteConfig(home));
    app = createApp(store, { typicalFactLimit: 8 });
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://local.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function patch(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://local.test${path}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function get(path: string): Promise<Response> {
    return app.fetch(new Request(`http://local.test${path}`));
  }

  it("GET /facts reports honest meta.available under a limit", async () => {
    // A `data.length` fake would report 5 here, not 12.
    for (let i = 0; i < 12; i++) {
      await post("/facts", { fact: `env fact ${i}`, scope: "env-facts" });
    }
    const body = await (await get("/facts?scope=env-facts&limit=5")).json();
    expect(body.data.length).toBe(5);
    expect(body.meta.returned).toBe(5);
    expect(body.meta.available).toBe(12);
    expect(body.meta.truncated).toBe(true);
    expect(body.meta.limit).toBe(5);
  });

  it("GET /sessions reports honest meta.available under a limit", async () => {
    for (let i = 0; i < 10; i++) {
      await post("/sessions", { summary: `env session ${i}`, project: "env-sessions" });
    }
    const body = await (await get("/sessions?project=env-sessions&limit=4")).json();
    expect(body.data.length).toBe(4);
    expect(body.meta.returned).toBe(4);
    expect(body.meta.available).toBe(10);
    expect(body.meta.truncated).toBe(true);
  });

  it("GET /docs reports honest meta.available under a limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grounded-api-docs-env-"));
    try {
      for (let i = 0; i < 8; i++) {
        writeFileSync(
          join(dir, `doc-${i}.md`),
          `# Doc ${i}\n\nenv docs delivery meta content number ${i}.\n`,
          "utf8",
        );
      }
      const ingestRes = await post("/docs/ingest", { paths: [dir], source: "env-docs" });
      expect(ingestRes.status).toBe(200);

      const body = await (await get("/docs?source=env-docs&limit=3")).json();
      expect(body.data.length).toBe(3);
      expect(body.meta.returned).toBe(3);
      expect(body.meta.available).toBe(8);
      expect(body.meta.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /recall reports meta.bySource with honest per-source counts", async () => {
    const token = "zzqrecalldeliverytoken";
    for (let i = 0; i < 5; i++) {
      await post("/facts", { fact: `${token} fact number ${i}`, scope: "global" });
    }
    const body = await (await post("/recall", { query: token, limit: 10 })).json();
    expect(body.meta.bySource?.fact).toBeTruthy();
    expect(body.meta.bySource.fact.returned).toBe(5);
    expect(body.meta.bySource.fact.available).toBe(5);
  });

  it("POST /facts returns delivery.rank/ofActive for a fresh unpinned fact in an empty scope", async () => {
    const body = await (await post("/facts", { fact: "solo fact", scope: "solo-test" })).json();
    expect(body.delivery).toEqual({ rank: 1, ofActive: 1, delivered: true });
  });

  it("POST /facts includes a warning once rank exceeds typicalFactLimit", async () => {
    // 8 higher-importance filler facts push a 9th, lower-importance fact to
    // rank 9 of 9 — past the typicalFactLimit of 8 passed to createApp above.
    // A broken computeDeliveryRank (e.g. always delivered:true, or a rank
    // that ignores importance ordering) fails this.
    for (let i = 0; i < 8; i++) {
      await post("/facts", { fact: `warning filler ${i}`, scope: "warning-test", importance: 0.9 });
    }
    const buried = await (
      await post("/facts", { fact: "buried fact", scope: "warning-test", importance: 0.1 })
    ).json();
    expect(buried.delivery.rank).toBe(9);
    expect(buried.delivery.ofActive).toBe(9);
    expect(buried.delivery.delivered).toBe(false);
    expect(buried.delivery.warning).toMatch(/rank 9 of 9/);
  });

  it("POST /facts omits delivery for a fact created archived (no delivery position, not rank 0)", async () => {
    const body = await (
      await post("/facts", { fact: "created archived for delivery check", status: "archived" })
    ).json();
    expect("delivery" in body).toBe(false);
  });

  it("PATCH /facts/:id with an explicit createdBy actually persists it", async () => {
    // The field is untouched on an ordinary patch, so a preservation-only test
    // would pass against the unfixed factPatch() that never reads body.createdBy.
    const created = await (
      await post("/facts", { fact: "createdBy round-trip", scope: "createdby-test" })
    ).json();
    expect(created.createdBy == null).toBe(true);

    const patched = await (await patch(`/facts/${created.id}`, { createdBy: "bob" })).json();
    expect(patched.createdBy).toBe("bob");

    // Re-fetch independently of the PATCH response to confirm it was actually stored.
    const list = await (await get("/facts?scope=createdby-test&status=all")).json();
    const persisted = list.data.find((f: { id: number }) => f.id === created.id);
    expect(persisted.createdBy).toBe("bob");
  });
});

describe("@grounded/api brief delivery accounting", () => {
  let home: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-api-brief-"));
    const cfg = sqliteConfig(home);
    // Tiny reserves force truncation deterministically without huge fixtures.
    cfg.brief.reserve = { vision: 20, facts: 20, sessions: 20 };
    store = await openStore(cfg);
    app = createApp(store);
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://local.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("POST /brief reports meta.{vision,facts,sessions} and real, resolvable droppedItems", async () => {
    await post("/vision", { details: "x".repeat(500), scope: "global" });
    for (let i = 0; i < 5; i++) {
      await post("/facts", {
        fact: `brief reserve fact number ${i} with enough padding text to consume the tiny budget quickly`,
        scope: "global",
      });
    }

    const res = await post("/brief", {});
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.meta.vision).toBeTruthy();
    expect(body.meta.facts).toBeTruthy();
    expect(body.meta.sessions).toBeTruthy();
    expect(body.meta.vision.truncated).toBe(true);
    expect(body.meta.facts.truncated).toBe(true);

    expect(Array.isArray(body.droppedItems)).toBe(true);
    expect(body.droppedItems.length).toBeGreaterThan(0);
    // vision has no arm in SourceType/TypedId — it must never appear here.
    expect(body.droppedItems.every((id: string) => !id.startsWith("vision"))).toBe(true);

    // droppedItems must be real ids, not decorative — GET /get/:typedId resolves them.
    const getRes = await app.fetch(new Request(`http://local.test/get/${body.droppedItems[0]}`));
    expect(getRes.status).toBe(200);
    const record = await getRes.json();
    expect(record.sourceType).toBe("fact");
  });
});

describe("@grounded/api delivery defaults", () => {
  it("createApp's fallback typicalFactLimit matches defaultConfig()", async () => {
    // app.ts keeps a local DEFAULT_TYPICAL_FACT_LIMIT for embedders that call
    // createApp(store) with no config. If defaultConfig() ever moves, the two
    // drift apart silently and the console/API disagree about whether a fact
    // is deliverable — which is the exact class of divergence stage 2 exists
    // to remove. Prove they agree by observation, not by reading the constant.
    const home = mkdtempSync(join(tmpdir(), "grounded-delivery-default-"));
    const store = await openStore(sqliteConfig(home));
    await store.init();
    try {
      const limit = defaultConfig(home).delivery.typicalFactLimit;
      const app = createApp(store); // no typicalFactLimit -> the fallback

      // Seed exactly `limit` facts, all in one scope, ascending importance so
      // the newest-and-lowest sorts last. Fact #limit sits exactly AT the
      // threshold: still delivered, no warning.
      for (let i = 0; i < limit; i++) {
        const res = await app.fetch(
          new Request("http://local.test/facts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              fact: `seed ${i}`,
              scope: "dl",
              importance: 1 - i * 0.01,
            }),
          }),
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.delivery.rank).toBe(i + 1);
        expect(body.delivery.delivered).toBe(true);
        expect(body.delivery.warning).toBeUndefined();
      }

      // One more tips it over: rank limit+1 is not delivered and must warn.
      const over = await app.fetch(
        new Request("http://local.test/facts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact: "over", scope: "dl", importance: 0.1 }),
        }),
      );
      const overBody = await over.json();
      expect(overBody.delivery.rank).toBe(limit + 1);
      expect(overBody.delivery.delivered).toBe(false);
      expect(overBody.delivery.warning).toContain(`top ${limit}`);
    } finally {
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
