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

  // Measured 2026-08-31: two live facts stored importance 4, which multiplies
  // recall score by 5 (vs 1.6-1.95 normal) and sorts above pinned in the brief.
  it("rejects importance outside 0..1 on POST and PATCH /facts", async () => {
    for (const bad of [4, -0.5, 1.01]) {
      const res = await post("/facts", { fact: `imp ${bad}`, importance: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/between 0 and 1/);
    }

    const ok = await post("/facts", { fact: "clamped", importance: 1 });
    expect(ok.status).toBe(201);
    const { id } = await ok.json();

    const patched = await app.request(`/facts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importance: 4 }),
    });
    expect(patched.status).toBe(400);
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

  it("POST /impact forwards subject and scopes to the store, and returns the envelope unwrapped", async () => {
    const calls: Array<[string, unknown]> = [];
    const originalImpact = store.impact.bind(store);
    store.impact = (async (subject, opts) => {
      calls.push([subject, opts]);
      return originalImpact(subject, opts);
    }) as typeof store.impact;
    try {
      const res = await post("/impact", {
        subject: "grounded-postgres",
        scopes: ["global", "administration"],
      });
      expect(res.status).toBe(200);
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe("grounded-postgres");
      const opts = calls[0][1] as Record<string, unknown>;
      expect(opts.scopes).toEqual(["global", "administration"]);
      const body = await res.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
    } finally {
      store.impact = originalImpact;
    }
  });

  it("POST /impact rejects an invalid sources entry", async () => {
    const res = await post("/impact", { subject: "x", sources: ["nope"] });
    expect(res.status).toBe(400);
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

  it("PATCH /sessions/:id edits in place and keeps omitted fields", async () => {
    const created = await (
      await post("/sessions", { summary: "typo'd summary", project: "patch-me", workspace: "w1" })
    ).json();
    const res = await app.fetch(
      new Request(`http://local.test/sessions/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "fixed summary", workspace: "w2" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBe("fixed summary");
    expect(body.workspace).toBe("w2");
    expect(body.project).toBe("patch-me");
  });

  it("GET /sessions filters by workspace", async () => {
    const a = await (
      await post("/sessions", { summary: "ws filter a", project: "wsq", workspace: "one" })
    ).json();
    await post("/sessions", { summary: "ws filter b", project: "wsq", workspace: "two" });
    const body = await (await get("/sessions?project=wsq&workspace=one")).json();
    expect(body.data.map((s: { id: number }) => s.id)).toEqual([a.id]);
    expect(body.meta.available).toBe(1);
  });

  it("rejects unknown body keys instead of silently ignoring them", async () => {
    // the measured failure: a caller sent scopes/limit to /brief for weeks and
    // got a 200 while both were dropped.
    const brief = await post("/brief", { scopes: ["global"], limit: 5 });
    expect(brief.status).toBe(400);
    const err = await brief.json();
    expect(err.error).toMatch(/unknown field/);
    expect(err.error).toMatch(/scopes/);

    expect((await post("/sessions", { summary: "ok", proejct: "typo" })).status).toBe(400);
    expect((await post("/facts", { fact: "ok", scoep: "typo" })).status).toBe(400);
    expect((await post("/recall", { query: "x", workspace: "w" })).status).toBe(200);
  });

  it("POST /docs/ingest 400s on an unreadable path instead of reporting scanned:0", async () => {
    const res = await post("/docs/ingest", { paths: ["/nonexistent/grounded/root"] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INGEST_PATH_UNREADABLE");
    expect(body.paths).toEqual(["/nonexistent/grounded/root"]);
  });

  it("DELETE /sessions/:id removes the row, then 404s", async () => {
    const created = await (await post("/sessions", { summary: "throwaway row", project: "del" })).json();
    const del = await app.fetch(
      new Request(`http://local.test/sessions/${created.id}`, { method: "DELETE" }),
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true, id: created.id });
    expect((await get(`/sessions/${created.id}`)).status).toBe(404);
    const again = await app.fetch(
      new Request(`http://local.test/sessions/${created.id}`, { method: "DELETE" }),
    );
    expect(again.status).toBe(404);
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

  it("POST /recall: limit is a total across sources, ranked by score", async () => {
    // HTTP-level D1 regression: the old per-lane slice returned limit*sources
    // rows, so a caller asking for 5 across two populated lanes got 10.
    const token = "zzqhttptotallimit";
    for (let i = 0; i < 4; i++) {
      await post("/facts", { fact: `${token} fact number ${i}`, scope: "global" });
      await post("/sessions", { summary: `${token} session number ${i}`, project: "limits" });
    }
    const res = await post("/recall", { query: token, limit: 5 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(5);
    expect(body.meta.returned).toBe(5);
    expect(body.meta.limit).toBe(5);
    for (let i = 1; i < body.data.length; i++) {
      expect(body.data[i].score).toBeLessThanOrEqual(body.data[i - 1].score);
    }
    const sum = Object.values(body.meta.bySource as Record<string, { returned: number }>).reduce(
      (n, e) => n + e.returned,
      0,
    );
    expect(sum).toBe(body.meta.returned);
  });

  it("POST /facts warns on an over-long fact but still returns 200 (warning, not rejection)", async () => {
    const long = "z".repeat(300);
    const res = await post("/facts", { fact: long, scope: "length-test" });
    // explicitly the normal create status, NOT 400 — the 400 lane is for
    // malformed input (see the importance guard), not a verbose fact.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.delivery.warning).toMatch(/chars/);

    const shortened = await patch(`/facts/${body.id}`, { fact: "z".repeat(50) });
    expect(shortened.status).toBe(200);
    const after = await shortened.json();
    expect(after.delivery?.warning ?? "").not.toMatch(/chars/);
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

  it("POST /facts warns once the pinned set crosses 75% of the facts reserve, not below it", async () => {
    // A dedicated app with a tiny facts reserve so a couple of pinned facts
    // can deterministically cross the 75% threshold without huge fixtures.
    const pinHome = mkdtempSync(join(tmpdir(), "grounded-api-pinned-reserve-"));
    const pinCfg = sqliteConfig(pinHome);
    pinCfg.brief.reserve = { vision: 400, facts: 40, sessions: 500 };
    const pinStore = await openStore(pinCfg);
    const pinApp = createApp(pinStore, { typicalFactLimit: 8, factsReserveTok: 40 });
    const pinPost = (body: unknown): Promise<Response> =>
      pinApp.fetch(
        new Request("http://local.test/facts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    try {
      const first = await (
        await pinPost({ fact: "small pinned fact", scope: "pin-reserve-test", pinned: true })
      ).json();
      // One short pinned fact shouldn't crowd a 40-token reserve on its own.
      expect(first.delivery.warning).toBeUndefined();

      const second = await (
        await pinPost({
          fact: "a second pinned fact with enough padding text to push the pinned set well past most of the reserve",
          scope: "pin-reserve-test",
          pinned: true,
        })
      ).json();
      expect(second.delivery.warning).toMatch(/pinned facts use \d+% of the facts reserve/);
    } finally {
      await pinStore.close();
      rmSync(pinHome, { recursive: true, force: true });
    }
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

  it("POST /brief reports meta.{vision,facts,sessions} truncation", async () => {
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

    // vision has no arm in SourceType/TypedId — it must never appear here.
    expect(Array.isArray(body.droppedItems)).toBe(true);
    expect(body.droppedItems.every((id: string) => !id.startsWith("vision"))).toBe(true);
  });

  it("POST /brief accounts for overflow facts across facts/indexedItems/droppedItems", async () => {
    // A reserve this small (5 tok = 20 chars) only fits the mandatory
    // item[0] in full text; everything else overflows into the index tier,
    // and enough facts here blow even the 300-tok index budget so some are
    // truly dropped too — exercising all three tiers at once.
    const briefHome = mkdtempSync(join(tmpdir(), "grounded-api-brief-overflow-"));
    const cfg = sqliteConfig(briefHome);
    cfg.brief.reserve = { vision: 20, facts: 5, sessions: 20 };
    const overflowStore = await openStore(cfg);
    const overflowApp = createApp(overflowStore);
    const overflowPost = (path: string, body: unknown): Promise<Response> =>
      overflowApp.fetch(
        new Request(`http://local.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    try {
      for (let i = 0; i < 31; i++) {
        await overflowPost("/facts", {
          fact: `index cap fact number ${i} with enough text to blow a tiny budget`,
          scope: "global",
          importance: 0.9 - i * 0.01,
        });
      }

      const res = await overflowPost("/brief", {});
      expect(res.status).toBe(200);
      const body = await res.json();

      // Every fact is accounted for exactly once, across the three tiers.
      const accountedFor = body.facts.length + body.indexedItems.length + body.droppedItems.length;
      expect(accountedFor).toBe(31);
      expect(body.indexedItems.length).toBeGreaterThan(0);
      expect(body.droppedItems.length).toBeGreaterThan(0);

      // meta.facts.returned counts only full-text rows, never inflated by
      // indexed ones; meta.facts.indexed mirrors indexedItems.length.
      expect(body.meta.facts.returned).toBe(body.facts.length);
      expect(body.meta.facts.indexed).toBe(body.indexedItems.length);

      // droppedItems are real, resolvable ids and truly absent from the text.
      const getRes = await overflowApp.fetch(
        new Request(`http://local.test/get/${body.droppedItems[0]}`),
      );
      expect(getRes.status).toBe(200);
      const record = await getRes.json();
      expect(record.sourceType).toBe("fact");
      for (const id of body.droppedItems as string[]) {
        const dropped = record.id === Number(id.split(":")[1]) ? record : await (
          await overflowApp.fetch(new Request(`http://local.test/get/${id}`))
        ).json();
        expect(body.text).not.toContain(dropped.fact);
      }

      // indexedItems ARE present in the text, but only as their compressed
      // index line — never the full fact text.
      for (const id of body.indexedItems as string[]) {
        const indexedRes = await overflowApp.fetch(new Request(`http://local.test/get/${id}`));
        const indexedRecord = await indexedRes.json();
        expect(body.text).not.toContain(indexedRecord.fact);
        expect(body.text).toContain(`(${id})`);
      }
    } finally {
      await overflowStore.close();
      rmSync(briefHome, { recursive: true, force: true });
    }
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

describe("@grounded/api /llms.txt", () => {
  it("serves the manual as text/markdown", async () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-api-"));
    const store = await openStore(sqliteConfig(home));
    const app = createApp(store);
    try {
      const res = await app.fetch(new Request("http://local.test/llms.txt"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain("# Grounded");
      // Anchor the load-bearing sections. `length > 0` and a title match would
      // still pass with the entire guidance body deleted — and this file is the
      // only place an agent is told how to write a fact, what frontmatter does
      // not do, and to flag drift it walks past. Assert the claims, not the type.
      for (const anchor of [
        "## How to write a fact",
        "## Docs and frontmatter",
        "## Keep the record honest",
        // Frontmatter is stripped, never parsed — the misconception most likely
        // to silently corrupt a corpus if this section goes missing.
        "Frontmatter is **stripped, not parsed.**",
        // The write-side check that turns a 200 into a delivery guarantee.
        "delivered: false",
      ]) {
        expect(body).toContain(anchor);
      }
    } finally {
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is exempt from bearer auth while other routes still require it", async () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-api-"));
    const store = await openStore(sqliteConfig(home));
    const app = createApp(store, { token: "s3cret" });
    try {
      const llms = await app.fetch(new Request("http://local.test/llms.txt"));
      expect(llms.status).toBe(200);

      const facts = await app.fetch(new Request("http://local.test/facts"));
      expect(facts.status).toBe(401);
    } finally {
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("appears in the served /openapi.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-api-"));
    const store = await openStore(sqliteConfig(home));
    const app = createApp(store);
    try {
      const res = await app.fetch(new Request("http://local.test/openapi.json"));
      const doc = (await res.json()) as { paths: Record<string, unknown> };
      expect(doc.paths).toHaveProperty("/llms.txt");
    } finally {
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
