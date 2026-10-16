import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Databox, DataboxError, renderSchemaCard, validateBoxes } from "./index.js";
import { loadDuck } from "./duck.js";
import { parseType, refuseIncremental, typeFits } from "./incremental.js";
import { toJson } from "./query.js";

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
    expect(names).toEqual(["cars.items", "cars.meshes", "cars.meshes_uv", "cars.tags", "library.items", "library.params"]);
    const items = ptr.tables.find((t) => t.name === "cars.items")!;
    expect(items.columns.map((c) => c.name)).toEqual(["_item", "car", "year"]);
    expect(items.rows).toBe(2);
    const r = await w.query("cars", "select _item, _n, value from cars.tags order by _item, _n");
    expect(r.data).toEqual([{ _item: "A", _n: 1, value: "x" }, { _item: "A", _n: 2, value: "y" }]);
    // an array of objects inside an array table is its own child table, keyed by the parent position
    const meshes = ptr.tables.find((t) => t.name === "cars.meshes")!;
    expect(meshes.columns.map((c) => c.name)).not.toContain("uv");
    const uv = ptr.tables.find((t) => t.name === "cars.meshes_uv")!;
    expect(uv.columns.map((c) => c.name)).toEqual(["_item", "meshes_n", "_n", "ch", "uvm"]);
    const joined = await w.query(
      "cars",
      "select m.part, u.uvm from cars.meshes m join cars.meshes_uv u on u._item = m._item and u.meshes_n = m._n",
    );
    expect(joined.data).toEqual([{ part: "body", uvm: 2.5 }]);
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

d("incremental build", () => {
  /** 10 more cars so one or two edits stay under the incremental share. */
  const more = () => {
    for (let i = 0; i < 10; i++) item(`cars/D${i}.json`, { car: `D${i}`, year: 2000 + i, meshes: [{ part: "body", lod: 0, verts: i, uv: [] }], tags: ["d"] });
  };
  /** rewrite an item with an mtime clearly after the last build. */
  const edit = (rel: string, body: unknown) => {
    item(rel, body);
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(root, "items", rel), later, later);
  };
  const snapshot = async (w: Databox, tables: string[]) => {
    const out: Record<string, unknown> = {};
    for (const t of tables) out[t] = (await w.query("cars", `select * from ${t} order by all`, { limit: 5000 })).data;
    return out;
  };

  it("re-reads only changed items and answers exactly like a full build", async () => {
    more();
    const w = box();
    const first = await w.index("cars");
    expect(first.build).toMatchObject({ mode: "full" });

    edit("cars/A.json", {
      car: "A",
      year: 2022,
      meshes: [{ part: "body", lod: 0, verts: 101, uv: [{ ch: 0, uvm: 3 }, { ch: 1, uvm: 4 }] }],
      tags: ["z"],
    });
    rmSync(join(root, "items", "cars", "D9.json"));
    const inc = await w.index("cars");
    expect(inc.build).toEqual({ mode: "incremental", changed: 1, removed: 1 });
    const tables = inc.tables.map((t) => t.name);
    const got = await snapshot(w, tables);
    expect((got["cars.meshes_uv"] as unknown[]).length).toBe(2);
    expect(got["cars.items"]).not.toContainEqual(expect.objectContaining({ _item: "D9" }));

    const full = await w.index("cars", { force: true });
    expect(full.build).toEqual({ mode: "full", reason: "full build requested" });
    expect(await snapshot(w, tables)).toEqual(got);
    expect(full.tables.map((t) => [t.name, t.rows])).toEqual(inc.tables.map((t) => [t.name, t.rows]));
    await w.close();
  });

  it("keeps a column only removed items used until the next full build", async () => {
    more();
    const w = box();
    await w.index("cars");
    rmSync(join(root, "items", "cars", "B.json")); // the only item with meshes.extra
    const cols = (p: { tables: { name: string; columns: { name: string }[] }[] }) =>
      p.tables.find((t) => t.name === "cars.meshes")!.columns.map((c) => c.name);
    expect(cols(await w.index("cars"))).toContain("extra");
    expect(cols(await w.index("cars", { force: true }))).not.toContain("extra");
    await w.close();
  });

  it("falls back to a full build when a changed item adds a key or widens a type", async () => {
    more();
    const w = box();
    await w.index("cars");
    edit("cars/D0.json", { car: "D0", year: 2000, color: "red", meshes: [], tags: [] });
    const a = await w.index("cars");
    expect(a.build).toMatchObject({ mode: "full", reason: expect.stringMatching(/add key "color"/) });
    expect(a.tables.find((t) => t.name === "cars.items")!.columns.map((c) => c.name)).toContain("color");

    edit("cars/D1.json", { car: "D1", year: 2001.5, meshes: [], tags: [] });
    const b = await w.index("cars");
    expect(b.build).toMatchObject({ mode: "full", reason: expect.stringMatching(/year: changed items need DOUBLE/) });
    await w.close();
  });

  it("adds a new item to another kind incrementally", async () => {
    more();
    const w = box();
    await w.index("cars");
    // library: params is the only array; a new library item is 1 of 14 items
    edit("library/steel.json", { name: "steel", params: [{ hash: "0x2", value: 1 }] });
    const inc = await w.index("cars");
    expect(inc.build).toMatchObject({ mode: "incremental", changed: 1 });
    const r = await w.query("cars", "select name from library.items order by 1");
    expect(r.data).toEqual([{ name: "bronze" }, { name: "steel" }]);
    await w.close();
  });
});

d("type hints", () => {
  it("casts the columns manifest.json names and fails on a hint that names no column", async () => {
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ game: 1, databox: { types: { "cars.meshes_uv.uvm": "FLOAT" } } }));
    const w = box();
    const ptr = await w.index("cars");
    const uv = ptr.tables.find((t) => t.name === "cars.meshes_uv")!;
    expect(uv.columns.find((c) => c.name === "uvm")!.type).toBe("FLOAT");
    expect((await w.query("cars", "select uvm from cars.meshes_uv")).data).toEqual([{ uvm: 2.5 }]);

    writeFileSync(join(root, "manifest.json"), JSON.stringify({ databox: { types: { "cars.meshes.nope": "FLOAT" } } }));
    await expect(w.index("cars")).rejects.toMatchObject({ code: "DATABOX_BUILD", message: expect.stringMatching(/names no column: cars.meshes.nope/) });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ databox: { types: { "cars.meshes.verts": "INT); DROP TABLE x; --" } } }));
    await expect(w.index("cars")).rejects.toMatchObject({ code: "DATABOX_BUILD" });
    await w.close();
  });
});

describe("typeFits", () => {
  const fits = (d: string, s: string) => typeFits(parseType(d), parseType(s));
  it("accepts what a full build would infer the same way", () => {
    expect(fits("BIGINT", "DOUBLE")).toBe(true);
    expect(fits("UBIGINT", "HUGEINT")).toBe(true);
    expect(fits("JSON[]", "STRUCT(a BIGINT)[]")).toBe(true); // only empty arrays changed
    expect(fits("STRUCT(a BIGINT)[]", 'STRUCT(a DOUBLE, "where" VARCHAR)[]')).toBe(true);
    expect(fits("DOUBLE", "JSON")).toBe(true);
    expect(fits("NULL", "BIGINT")).toBe(true);
  });
  it("refuses what would change the schema", () => {
    expect(fits("DOUBLE", "BIGINT")).toBe(false);
    expect(fits("UBIGINT", "BIGINT")).toBe(false);
    expect(fits("STRUCT(a BIGINT, b VARCHAR)[]", "STRUCT(a BIGINT)[]")).toBe(false);
    expect(fits("STRUCT(a BIGINT)[]", "JSON[]")).toBe(false);
    expect(fits("BIGINT[]", "BIGINT")).toBe(false);
    expect(fits("JSON", "BIGINT")).toBe(false);
  });
});

describe("toJson", () => {
  it("prints FLOAT values as their shortest float32 decimal and leaves DOUBLE alone", () => {
    const f = Math.fround(0.011410641);
    expect(toJson([f, 2.5], parseType("FLOAT[4]"))).toEqual([0.011410641, 2.5]);
    expect(toJson({ min: [f], d: f }, parseType("STRUCT(min FLOAT[3], d DOUBLE)"))).toEqual({ min: [0.011410641], d: f });
    expect(toJson(f)).toBe(f);
  });
});

describe("refuseIncremental", () => {
  const scan = { itemsDir: "x", kinds: [{ kind: "cars", prefix: "", glob: "", files: 10 }], files: 10, bytes: 0, newestMtimeMs: 0, fingerprint: "f", stamps: {}, hints: {} };
  const meta = { format: 1 as const, hints: "{}", kinds: { cars: [] }, stamps: {}, fullBytes: 100 };
  const prev = { id: "p", builtAt: "", buildMs: 0, fingerprint: "", files: 10, bytes: 0, tables: [], format: 1 };
  const one = { changed: ["cars/A.json"], removed: [] };
  it("compacts once the index grew 25% past its last full build", () => {
    expect(refuseIncremental(meta, prev, scan, one, 120)).toBeNull();
    expect(refuseIncremental(meta, prev, scan, one, 130)).toMatch(/grew 30% .* compacting/);
  });
  it("goes full when many items changed or the hints changed", () => {
    expect(refuseIncremental(meta, prev, scan, { changed: ["a", "b", "c"], removed: [] }, 100)).toMatch(/3 of 10 items changed/);
    expect(refuseIncremental({ ...meta, hints: '{"a.b":"FLOAT"}' }, prev, scan, one, 100)).toBe("type hints changed");
  });
});
