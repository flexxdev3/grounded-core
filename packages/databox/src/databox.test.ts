import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Databox, DataboxError, renderSchemaCard, validateBoxes } from "./index.js";
import { loadDuck } from "./duck.js";

const hasDuck = (await loadDuck()) !== null;
const d = describe.skipIf(!hasDuck);

let root: string;
const item = (rel: string, body: unknown) => {
  const p = join(root, "items", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(body));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "databox-"));
  item("cars/A.json", {
    car: "A",
    year: 2021,
    meshes: [
      { part: "body", lod: 0, verts: 100, uv: [{ ch: 0, uvm: 2.5 }] },
      { part: "wheel", lod: 1, verts: 50, uv: [] },
    ],
    tags: ["x", "y"],
  });
  item("cars/B.json", { car: "B", year: 2019, meshes: [{ part: "body", lod: 0, verts: 300, uv: [], extra: "hi" }], tags: [] });
  item("library/bronze.json", { name: "bronze", params: [{ hash: "0x1", value: 2.4 }] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const box = (writer = true, onIndexed?: ConstructorParameters<typeof Databox>[0]["onIndexed"]) =>
  new Databox({ boxes: [{ name: "cars", root, description: "test cars" }], writer, log: () => {}, ...(onIndexed ? { onIndexed } : {}) });

describe("writeDataboxConfig", () => {
  it("replaces the databox block and keeps everything else", async () => {
    const { writeDataboxConfig } = await import("./index.js");
    const { parse } = await import("smol-toml");
    const p = join(root, "config.toml");
    writeFileSync(
      p,
      '# mine\n[storage]\nadapter = "sqlite"\n\n[databox]\nenabled = false\n\n[[databox.box]]\nname = "old"\nroot = "x"\n\n[embeddings]\nprovider = "none"\n',
    );
    writeDataboxConfig(p, { enabled: true, box: [{ name: "cars", root: "C:\\data\\cars", description: 'say "hi"' }] });
    const text = (await import("node:fs")).readFileSync(p, "utf8");
    expect(text).toContain("# mine");
    expect(text).not.toContain('"old"');
    const cfg = parse(text) as Record<string, any>;
    expect(cfg.storage.adapter).toBe("sqlite");
    expect(cfg.embeddings.provider).toBe("none");
    expect(cfg.databox).toEqual({ enabled: true, box: [{ name: "cars", root: "C:\\data\\cars", description: 'say "hi"' }] });
  });
});

describe("config", () => {
  it("validates box entries", () => {
    expect(validateBoxes(undefined)).toEqual([]);
    expect(() => validateBoxes([{ name: "Bad Name", root: "x" }])).toThrow(/name must match/);
    expect(() => validateBoxes([{ name: "a", root: "x" }, { name: "a", root: "y" }])).toThrow(/twice/);
    expect(() => validateBoxes([{ name: "a" }])).toThrow(/root/);
  });
});

d("Databox", () => {
  it("answers from the JSON before any index exists, then from the index", async () => {
    const db = box(false);
    const r1 = await db.query("cars", "select _item, count(*) n from cars.meshes group by 1 order by 1");
    expect(r1.meta.source).toBe("json");
    expect(r1.data).toEqual([{ _item: "A", n: 2 }, { _item: "B", n: 1 }]);
    await db.close();

    const w = box(true);
    const ptr = await w.index("cars");
    expect(ptr.files).toBe(3);
    const r2 = await w.query("cars", "select _item, count(*) n from cars.meshes group by 1 order by 1");
    expect(r2.meta.source).toBe("index");
    expect(r2.data).toEqual(r1.data);
    expect(r2.meta.citation).toBe("databox:cars");
    await w.close();
  });

  it("maps files to tables: items, array tables with _n, scalar arrays as value", async () => {
    const w = box();
    const ptr = await w.index("cars");
    const names = ptr.tables.map((t) => t.name).sort();
    expect(names).toEqual(["cars.items", "cars.meshes", "cars.tags", "library.items", "library.params"]);
    const items = ptr.tables.find((t) => t.name === "cars.items")!;
    expect(items.columns.map((c) => c.name)).toEqual(["_item", "car", "year"]);
    expect(items.rows).toBe(2);
    const r = await w.query("cars", "select _item, _n, value from cars.tags order by _item, _n");
    expect(r.data).toEqual([{ _item: "A", _n: 1, value: "x" }, { _item: "A", _n: 2, value: "y" }]);
    const nested = await w.query("cars", "select u.uvm from cars.meshes, unnest(uv) t(u) where _item = 'A'");
    expect(nested.data).toEqual([{ uvm: 2.5 }]);
    await w.close();
  });

  it("caps rows but counts all of them", async () => {
    const w = box();
    const r = await w.query("cars", "select * from range(250)", { limit: 10 });
    expect(r.meta).toMatchObject({ returned: 10, available: 250, truncated: true, availableIsFloor: false });
    expect(r.data[0]).toEqual({ range: 0 });
    await w.close();
  });

  it("is read-only and sandboxed, on the index and on the JSON fallback", async () => {
    for (const writer of [false, true]) {
      const db = box(writer);
      if (writer) await db.index("cars");
      const bad = [
        "create table x as select 1",
        "insert into cars.items values ('z', 'z', 1)",
        `copy (select 1) to '${join(root, "leak.csv").replaceAll("\\", "/")}'`,
        `select * from read_text('${join(root, "..").replaceAll("\\", "/")}/*')`,
        "set enable_external_access = true",
        "attach 'x.duckdb' as x",
        "install httpfs",
        "select 1; select 2",
      ];
      for (const sql of bad) {
        await expect(db.query("cars", sql), sql).rejects.toBeInstanceOf(DataboxError);
      }
      await db.close();
    }
    expect(readdirSync(root)).not.toContain("leak.csv");
  });

  it("reports bad SQL as a 400 and an unknown box as a 404", async () => {
    const w = box();
    await expect(w.query("cars", "select nope from cars.items")).rejects.toMatchObject({ code: "DATABOX_SQL", status: 400 });
    await expect(w.query("nobox", "select 1")).rejects.toMatchObject({ code: "DATABOX_NOT_FOUND", status: 404 });
    await w.close();
  });

  it("flags a stale index, rebuilds, and swaps generations while a reader holds the old one", async () => {
    const w = box();
    await w.index("cars");
    const reader = box(false);
    expect((await reader.query("cars", "select count(*) n from cars.items")).data).toEqual([{ n: 2 }]);

    item("cars/C.json", { car: "C", year: 2024, meshes: [], tags: [] });
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "items", "cars", "C.json"), later, later);
    await new Promise((r) => setTimeout(r, 2100)); // scan TTL
    const st = await reader.status("cars");
    expect(st.state).toBe("stale");

    await w.index("cars");
    const after = await reader.query("cars", "select count(*) n from cars.items");
    expect(after.data).toEqual([{ n: 3 }]);
    expect(after.meta.stale).toBe(false);
    const gens = readdirSync(join(root, "index")).filter((f) => f.endsWith(".duckdb"));
    expect(gens.length).toBe(1);
    await reader.close();
    await w.close();
  });

  it("keeps serving the old index when a build fails, and records the error", async () => {
    const w = box();
    await w.index("cars");
    writeFileSync(join(root, "items", "cars", "broken.json"), "{ not json");
    await expect(w.index("cars")).rejects.toMatchObject({ code: "DATABOX_BUILD" });
    const st = await w.status("cars");
    expect(st.lastError?.message).toMatch(/index build failed/);
    expect(st.index).not.toBeNull();
    expect((await w.query("cars", "select count(*) n from cars.items")).meta.source).toBe("index");
    await w.close();
  });

  it("calls onIndexed with a schema the card renders", async () => {
    let card = "";
    const w = box(true, (_b, schema, ptr) => {
      card = renderSchemaCard(schema, { files: ptr.files });
    });
    await w.index("cars");
    expect(card).toContain("# Databox box: cars");
    expect(card).toContain("### cars.meshes (3 rows)");
    expect(card).toContain("databox:cars");
    await w.close();
  });

  it("an empty box says so", async () => {
    const empty = mkdtempSync(join(tmpdir(), "databox-empty-"));
    const db = new Databox({ boxes: [{ name: "e", root: empty }], writer: true, log: () => {} });
    expect((await db.status("e")).state).toBe("empty");
    await expect(db.query("e", "select 1")).rejects.toMatchObject({ code: "DATABOX_EMPTY", status: 409 });
    rmSync(empty, { recursive: true, force: true });
  });
});
