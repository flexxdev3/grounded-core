import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cabinetDir, defaultConfig, openStore } from "@grounded/core";
import type { GroundedConfig, Store } from "@grounded/core/contract";
import { duckHealth } from "@grounded/databox";
import { createApp } from "./app.js";
import { createServiceDatabox } from "./databox.js";

const hasDuck = (await duckHealth()).ok;

function config(home: string, boxRoot: string, enabled = true): GroundedConfig {
  const cfg = defaultConfig(home);
  cfg.storage.path = join(home, "grounded.db");
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 0;
  cfg.databox = { enabled, box: [{ name: "cars", root: boxRoot, description: "test cars" }] };
  return cfg;
}

describe("/databox when off", () => {
  it("lists nothing, says it is off, and 404s a box route with the way to turn it on", async () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-dbx-off-"));
    const store = await openStore(config(home, home, false));
    const app = createApp(store);
    const list = await (await app.fetch(new Request("http://t/databox"))).json();
    expect(list).toEqual({ data: [], meta: { returned: 0, available: 0, truncated: false, enabled: false } });
    const res = await app.fetch(new Request("http://t/databox/cars/schema"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("DATABOX_DISABLED");
    const health = (await (await app.fetch(new Request("http://t/health"))).json()) as { databox: unknown };
    expect(health.databox).toMatchObject({ enabled: false, ok: true });
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
});

describe.skipIf(!hasDuck)("/databox", () => {
  let home: string;
  let boxRoot: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;
  let db: ReturnType<typeof createServiceDatabox>;

  const post = (path: string, body: unknown) =>
    app.fetch(new Request(`http://t${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const get = (path: string) => app.fetch(new Request(`http://t${path}`));

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-dbx-"));
    boxRoot = join(home, "box");
    mkdirSync(join(boxRoot, "items"), { recursive: true });
    for (const [n, verts] of [["A", 100], ["B", 300]] as const) {
      writeFileSync(join(boxRoot, "items", `${n}.json`), JSON.stringify({ car: n, meshes: [{ part: "body", lod: 0, verts }] }));
    }
    writeFileSync(join(boxRoot, "manifest.json"), JSON.stringify({ BuildNumber: 4242, extractor: "test 1" }));
    const cfg = config(home, boxRoot);
    store = await openStore(cfg);
    db = createServiceDatabox(cfg, store);
    app = createApp(store, { databox: db! });
  });

  afterAll(async () => {
    await db?.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("indexes on demand and reports the box", async () => {
    const res = await post("/databox/cars/index", { wait: true });
    expect(res.status).toBe(200);
    const list = (await (await get("/databox")).json()) as { data: { name: string; state: string; manifest: unknown }[]; meta: { enabled: boolean } };
    expect(list.meta.enabled).toBe(true);
    expect(list.data[0]).toMatchObject({ name: "cars", state: "fresh", manifest: { BuildNumber: 4242 } });
  });

  it("answers a query in the {data, meta} envelope with a citation", async () => {
    const res = await post("/databox/cars/query", { sql: "select _item, verts from meshes order by verts desc", limit: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: Record<string, unknown> };
    expect(body.data).toEqual([{ _item: "B", verts: 300 }]);
    expect(body.meta).toMatchObject({ returned: 1, available: 2, truncated: true, source: "index", citation: "databox:cars" });
  });

  it("serves the schema", async () => {
    const body = (await (await get("/databox/cars/schema")).json()) as { data: { tables: { name: string; rows: number }[] } };
    expect(body.data.tables.map((t) => [t.name, t.rows])).toEqual([["items", 2], ["meshes", 2]]);
  });

  it("refuses writes, unknown keys, unknown boxes", async () => {
    expect((await post("/databox/cars/query", { sql: "drop table meshes" })).status).toBe(400);
    expect((await post("/databox/cars/query", { sql: "select 1", nope: 1 })).status).toBe(400);
    expect((await post("/databox/nobox/query", { sql: "select 1" })).status).toBe(404);
  });

  it("delivers the schema card into the docs lane", async () => {
    const card = join(cabinetDir(home), "databox", "cars.md");
    expect(existsSync(card)).toBe(true);
    expect(readFileSync(card, "utf8")).toContain("BuildNumber=4242");
    const docs = await store.docsList({ limit: 50 });
    expect(docs.data.some((d) => d.path?.endsWith("cars.md"))).toBe(true);
    const hits = await store.recall("databox box cars meshes", { limit: 5 });
    expect(hits.data.some((h) => (h.path ?? "").endsWith("cars.md"))).toBe(true);
  });

  it("reports databox on /health", async () => {
    const health = (await (await get("/health")).json()) as { databox: { enabled: boolean; ok: boolean; boxes: number } };
    expect(health.databox).toMatchObject({ enabled: true, ok: true, boxes: 1 });
  });
});
