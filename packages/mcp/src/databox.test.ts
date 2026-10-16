import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Store } from "@grounded/core";
import { Databox, duckHealth } from "@grounded/databox";
import { createServer } from "./server.js";

const hasDuck = (await duckHealth()).ok;

async function connect(databox?: Databox): Promise<Client> {
  const server = createServer({} as Store, databox ? { databox } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("databox tools", () => {
  it("are absent when Databox is off", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => n.startsWith("ground_databox"))).toBe(false);
  });
});

describe.skipIf(!hasDuck)("databox tools (reader)", () => {
  let root: string;
  let writer: Databox;
  let reader: Databox;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "grounded-mcp-dbx-"));
    mkdirSync(join(root, "items", "cars"), { recursive: true });
    writeFileSync(join(root, "items", "cars", "A.json"), JSON.stringify({ car: "A", meshes: [{ part: "body", verts: 100 }] }));
    writeFileSync(join(root, "items", "cars", "B.json"), JSON.stringify({ car: "B", meshes: [{ part: "body", verts: 300 }] }));
    const boxes = [{ name: "cars", root, description: "test cars" }];
    writer = new Databox({ boxes, writer: true, log: () => {} });
    await writer.index("cars");
    reader = new Databox({ boxes, writer: false, log: () => {} });
    client = await connect(reader);
  });

  afterAll(async () => {
    await reader.close();
    await writer.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers list, schema, query", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ground_databox_list", "ground_databox_schema", "ground_databox_query"]));
  });

  it("lists, describes and queries", async () => {
    const list = (await client.callTool({ name: "ground_databox_list", arguments: {} })) as CallToolResult;
    expect(textOf(list)).toMatch(/^cars {2}\[fresh\] {2}2 items/);

    const schema = (await client.callTool({ name: "ground_databox_schema", arguments: { box: "cars" } })) as CallToolResult;
    expect(textOf(schema)).toContain("cars.meshes (2 rows)");

    const q = (await client.callTool({
      name: "ground_databox_query",
      arguments: { box: "cars", sql: "select _item, verts from cars.meshes order by verts desc", limit: 1 },
    })) as CallToolResult;
    const t = textOf(q);
    expect(t).toMatch(/^1 of 2 rows \(truncated\)/);
    expect(t).toContain("cite: databox:cars");
    expect(t).toContain("_item | verts\nB | 300");
  });

  it("returns tool errors for writes, unknown boxes and unknown keys", async () => {
    const write = (await client.callTool({ name: "ground_databox_query", arguments: { box: "cars", sql: "drop table cars.meshes" } })) as CallToolResult;
    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/DATABOX_READ_ONLY/);
    const nobox = (await client.callTool({ name: "ground_databox_query", arguments: { box: "zzz", sql: "select 1" } })) as CallToolResult;
    expect(textOf(nobox)).toMatch(/DATABOX_NOT_FOUND/);
    const extra = (await client.callTool({ name: "ground_databox_query", arguments: { box: "cars", sql: "select 1", nope: 1 } })) as CallToolResult;
    expect(extra.isError).toBe(true);
  });
});
