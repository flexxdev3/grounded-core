import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    expect(after.length).toBe(before.length);
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
    expect(defaultList.some((f: { id: number }) => f.id === created.id)).toBe(false);

    const archivedList = await (await get("/facts?status=archived")).json();
    expect(archivedList.some((f: { id: number }) => f.id === created.id)).toBe(true);

    const allList = await (await get("/facts?status=all")).json();
    expect(allList.some((f: { id: number }) => f.id === created.id)).toBe(true);
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
