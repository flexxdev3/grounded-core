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
