/**
 * The MCP surface is the agent-facing contract: 17 tools, their input schemas,
 * and progressive disclosure (compact cards → timeline → full record by id).
 * The server is driven over a real in-memory MCP transport with a stub Store,
 * so schema validation and dispatch are exercised exactly as an agent would.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GroundedError } from "@grounded/core";
import { visionCapChars } from "@grounded/core/delivery";
import type { Store } from "@grounded/core";
import { createServer } from "./server.js";

// ---- stub store --------------------------------------------------------------

/** Every call the server makes, in order — the dispatch assertions read this. */
let calls: { method: string; args: unknown[] }[] = [];
/** Per-method override; anything unset returns the default fixture. */
let impls: Record<string, (...a: unknown[]) => unknown> = {};

const lastArgs = (method: string) => calls.find((c) => c.method === method)?.args;

function card(over: Record<string, unknown> = {}) {
  return {
    typedId: "doc:12",
    title: "network.md",
    snippet: "arch1 is 192.168.1.65",
    score: 0.87321,
    matchedBy: "both",
    citation: "docs/network.md",
    path: "docs/network.md",
    source: "homelab-context",
    ...over,
  };
}

const DEFAULTS: Record<string, unknown> = {
  recall: { data: [card()], meta: { returned: 1, available: 3, truncated: true, bySource: { doc: { returned: 1, available: 3 } } } },
  impact: { data: [card()], meta: { returned: 1, available: 1, truncated: false, bySource: { doc: { returned: 1, available: 1 } } } },
  sessionsTimeline: [{ id: 274, summary: "shipped recall caps" }],
  get: { id: 12, type: "doc", body: "the full body nobody sees in a card" },
  brief: { text: "# brief\n\nrecent work", startupNote: "note" },
  visionGet: { scope: "global", summary: "ship grounded" },
  visionSet: { id: 1, scope: "global" },
  factsAdd: { id: 7, fact: "port is 5433" },
  factsUpdate: { id: 7, fact: "port is 5433" },
  factsDeliveryRank: { rank: 2, ofActive: 40 },
  factsList: { data: [], meta: { returned: 0, available: 0, truncated: false } },
  factsDelete: true,
  sessionsAdd: { id: 900 },
  sessionsUpdate: { id: 900 },
  sessionsDelete: true,
  docsIngest: { added: 2, updated: 0, removed: 0 },
  docsPrune: { missing: 1, removed: 0 },
  health: { storage: { adapter: "sqlite", ok: true }, counts: { facts: 1 } },
};

const store = new Proxy({} as Store, {
  get(_t, prop: string) {
    return async (...args: unknown[]) => {
      calls.push({ method: prop, args });
      if (impls[prop]) return impls[prop]!(...args);
      if (prop in DEFAULTS) return DEFAULTS[prop];
      return null;
    };
  },
});

async function connect() {
  const server = createServer(store, { typicalFactLimit: 25, factsReserveTok: 1200, visionReserveTok: 400 });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

let client: Client;
beforeEach(async () => {
  calls = [];
  impls = {};
  client = await connect();
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
const textOf = (r: CallToolResult) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

// ---- the tool registry -------------------------------------------------------

const EXPECTED_TOOLS = [
  "ground_recall",
  "ground_impact",
  "ground_timeline",
  "ground_get",
  "ground_brief",
  "ground_vision_get",
  "ground_vision_set",
  "ground_facts_add",
  "ground_facts_update",
  "ground_facts_list",
  "ground_facts_delete",
  "ground_session_add",
  "ground_session_update",
  "ground_session_delete",
  "ground_docs_ingest",
  "ground_docs_prune",
  "ground_health",
];

describe("tool registry", () => {
  it("exposes exactly the 17 documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(tools).toHaveLength(17);
  });

  it("every tool carries a title, a non-trivial description, and an object schema", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.description!.length, t.name).toBeGreaterThanOrEqual(20);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("advertises progressive disclosure in the server instructions", async () => {
    const instructions = client.getInstructions();
    expect(instructions).toContain("ground_recall");
    expect(instructions).toContain("ground_get");
    expect(instructions).toContain("ground_timeline");
  });

  it("names no retired data verb (the CLI's facts/recall/session verbs are not MCP tools)", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.name.startsWith("ground_")).toBe(true);
  });
});

// ---- input schemas -----------------------------------------------------------

async function schema(name: string) {
  const { tools } = await client.listTools();
  return tools.find((t) => t.name === name)!.inputSchema as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

describe("input schemas", () => {
  it("ground_recall: query required, limit bounded to 200, sources enumerated", async () => {
    const s = await schema("ground_recall");
    expect(s.required).toEqual(["query"]);
    expect(Object.keys(s.properties).sort()).toEqual(
      ["lexicalOnly", "limit", "project", "query", "scopes", "sources"].sort(),
    );
    expect(s.properties.limit).toMatchObject({ type: "integer", exclusiveMinimum: 0, maximum: 200 });
    expect((s.properties.sources as { items: { enum: string[] } }).items.enum).toEqual([
      "fact",
      "session",
      "doc",
    ]);
  });

  it("ground_impact: subject required and bounded the same way as recall", async () => {
    const s = await schema("ground_impact");
    expect(s.required).toEqual(["subject"]);
    expect(s.properties.limit).toMatchObject({ maximum: 200 });
    expect(s.properties).not.toHaveProperty("lexicalOnly"); // lexical by construction
  });

  it("ground_facts_list gets the looser browse ceiling, not the retrieval ceiling", async () => {
    const s = await schema("ground_facts_list");
    expect(s.properties.limit).toMatchObject({ maximum: 5000 });
    expect((s.properties.status as { enum: string[] }).enum).toEqual(["active", "archived", "all"]);
  });

  it("ground_get: typedId is required and pattern-constrained to the three lanes", async () => {
    const s = await schema("ground_get");
    expect(s.required).toEqual(["typedId"]);
    expect(String(s.properties.typedId!.pattern)).toBe("^(fact|session|doc):\\d+$");
  });

  it("ground_facts_add: only `fact` is required; importance is a 0..1 range", async () => {
    const s = await schema("ground_facts_add");
    expect(s.required).toEqual(["fact"]);
    expect(s.properties.importance).toMatchObject({ minimum: 0, maximum: 1 });
    expect((s.properties.status as { enum: string[] }).enum).toEqual(["active", "archived"]);
    expect((s.properties.origin as { enum: string[] }).enum).toEqual(["stated", "derived"]);
  });

  it("ground_docs_ingest requires at least one path", async () => {
    const s = await schema("ground_docs_ingest");
    expect(s.required).toEqual(["paths"]);
    expect(s.properties.paths).toMatchObject({ type: "array", minItems: 1 });
  });

  it("ground_brief offers markdown|json and an explicit doc-lane scope set", async () => {
    const s = await schema("ground_brief");
    expect((s.properties.format as { enum: string[] }).enum).toEqual(["markdown", "json"]);
    expect(s.properties.docScopes).toMatchObject({ type: "array" });
    expect(s.required ?? []).toEqual([]);
  });

  it("ground_health takes no input", async () => {
    const s = await schema("ground_health");
    expect(Object.keys(s.properties ?? {})).toEqual([]);
  });

  it("id-taking tools require an integer id", async () => {
    for (const name of ["ground_facts_delete", "ground_facts_update", "ground_session_delete", "ground_session_update"]) {
      const s = await schema(name);
      expect(s.required, name).toContain("id");
      expect(s.properties.id, name).toMatchObject({ type: "integer" });
    }
  });
});

// ---- schema enforcement at call time ----------------------------------------

describe("argument validation", () => {
  const invalid = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args).catch((e) => ({ isError: true, content: [{ text: String(e) }] }) as CallToolResult);
    return r;
  };

  it("rejects a missing required argument without reaching the store", async () => {
    const r = await invalid("ground_recall", {});
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects limit above the 200 ceiling and at/below zero", async () => {
    for (const limit of [201, 0, -1, 1.5]) {
      calls = [];
      const r = await invalid("ground_recall", { query: "x", limit });
      expect(r.isError, `limit=${limit}`).toBe(true);
      expect(calls, `limit=${limit}`).toHaveLength(0);
    }
  });

  it("accepts limit exactly at the ceiling", async () => {
    const r = await call("ground_recall", { query: "x", limit: 200 });
    expect(r.isError).toBeFalsy();
    expect((lastArgs("recall")![1] as { limit: number }).limit).toBe(200);
  });

  it("rejects a facts_list limit above 5000 but accepts 5000", async () => {
    expect((await invalid("ground_facts_list", { limit: 5001 })).isError).toBe(true);
    expect((await call("ground_facts_list", { limit: 5000 })).isError).toBeFalsy();
  });

  it("rejects a malformed typedId before the store is asked", async () => {
    for (const typedId of ["vision:1", "doc:", "doc", "doc:abc"]) {
      calls = [];
      expect((await invalid("ground_get", { typedId })).isError, typedId).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  it("rejects an unknown source type", async () => {
    expect((await invalid("ground_recall", { query: "x", sources: ["vision"] })).isError).toBe(true);
  });

  it("rejects importance outside 0..1", async () => {
    expect((await invalid("ground_facts_add", { fact: "f", importance: 1.5 })).isError).toBe(true);
    expect((await invalid("ground_facts_add", { fact: "f", importance: -0.1 })).isError).toBe(true);
  });

  it("rejects a wrongly-typed argument", async () => {
    expect((await invalid("ground_recall", { query: 42 })).isError).toBe(true);
    expect((await invalid("ground_facts_delete", { id: "7" })).isError).toBe(true);
  });

  it("rejects an empty paths array for docs ingest", async () => {
    expect((await invalid("ground_docs_ingest", { paths: [] })).isError).toBe(true);
  });

  // KNOWN DEFECT: packages/mcp/src/server.ts:132+ — every inputSchema is a plain
  // (non-strict) zod object, so unknown keys are STRIPPED rather than rejected.
  // The HTTP surface 400s on an unknown body key; here a typo'd argument name is
  // silently dropped and the tool runs as if the caller never passed it. An agent
  // sending {query, limmit: 200} gets the default limit with no signal at all.
  it("KNOWN DEFECT: unknown arguments are silently ignored, not rejected like the HTTP surface", async () => {
    const r = await call("ground_recall", { query: "x", limmit: 200, nonsense: true });
    expect(r.isError).toBeFalsy();
    const opts = lastArgs("recall")![1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("limmit");
    expect(opts).not.toHaveProperty("limit"); // the typo silently became "no limit"
  });
});

// ---- progressive disclosure --------------------------------------------------

describe("progressive disclosure", () => {
  it("ground_recall returns compact cards — citation, score, snippet, but no body", async () => {
    impls.recall = () => ({
      data: [card(), card({ typedId: "fact:2", title: "a fact", path: null, source: null })],
      meta: { returned: 2, available: 9, truncated: true, bySource: { fact: { returned: 1, available: 4 }, doc: { returned: 1, available: 5 } } },
    });
    const body = textOf(await call("ground_recall", { query: "arch1" }));
    expect(body).toContain("2 of 9 matched");
    expect(body).toContain("fact 1/4");
    expect(body).toContain("doc 1/5");
    expect(body).toContain("truncated");
    expect(body).toContain("[doc:12] network.md  (docs/network.md)");
    expect(body).toContain("both · score=0.8732 · docs/network.md");
    expect(body).not.toContain("the full body nobody sees in a card");
    // the raw JSON tail is what an agent picks the next typedId out of
    expect(body).toContain("--- raw JSON (pick typedId) ---");
    const raw = JSON.parse(body.slice(body.lastIndexOf("---") + 3));
    expect(raw.map((r: { typedId: string }) => r.typedId)).toEqual(["doc:12", "fact:2"]);
  });

  it("recall renders a card with no path/source without a dangling location suffix", async () => {
    impls.recall = () => ({
      data: [card({ typedId: "fact:2", title: "a fact", path: null, source: null })],
      meta: { returned: 1, available: 1, truncated: false, bySource: {} },
    });
    const body = textOf(await call("ground_recall", { query: "x" }));
    expect(body).toContain("[fact:2] a fact\n");
    expect(body).not.toContain("()");
  });

  it("recall on no matches returns an empty JSON array, not a bare sentence", async () => {
    impls.recall = () => ({ data: [], meta: { returned: 0, available: 0, truncated: false } });
    expect(textOf(await call("ground_recall", { query: "nothing" }))).toBe("No results.\n\n[]");
  });

  it("ground_timeline expands a recall hit into surrounding sessions", async () => {
    const body = textOf(await call("ground_timeline", { around: 274, window: 3 }));
    expect(JSON.parse(body)).toEqual([{ id: 274, summary: "shipped recall caps" }]);
    expect(lastArgs("sessionsTimeline")![0]).toEqual({ around: 274, window: 3 });
  });

  it("ground_get fetches the full record — the body a card withheld", async () => {
    const body = textOf(await call("ground_get", { typedId: "doc:12" }));
    expect(JSON.parse(body).body).toBe("the full body nobody sees in a card");
    expect(lastArgs("get")![0]).toBe("doc:12");
  });

  it("ground_get reports a miss as a plain not-found, not an error result", async () => {
    impls.get = () => null;
    const r = await call("ground_get", { typedId: "doc:99999" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("Not found: doc:99999");
  });
});

// ---- impact lane withholding -------------------------------------------------

describe("ground_impact lane withholding", () => {
  it("returns out-of-lane hits as citation-only, never blank", async () => {
    impls.impact = () => ({
      data: [
        { ...card(), inScope: true },
        { ...card({ typedId: "doc:99", title: null, snippet: null }), inScope: false, scope: "administration" },
      ],
      meta: { returned: 2, available: 2, truncated: false, bySource: { doc: { returned: 2, available: 2 } } },
    });
    const body = textOf(await call("ground_impact", { subject: "5433" }));
    expect(body).toContain("[doc:99] (content withheld — lane: administration)");
    expect(body).toContain("docs/network.md"); // the citation still lands
    // no nulled-out title/snippet leaks into the rendered cards
    const cards = body.slice(0, body.indexOf("--- raw JSON"));
    expect(cards).not.toContain("null");
    // the in-lane card is rendered in full
    expect(body).toContain("arch1 is 192.168.1.65");
  });

  it("phrases an empty impact result as 'no dependents', not 'no results'", async () => {
    impls.impact = () => ({ data: [], meta: { returned: 0, available: 0, truncated: false } });
    expect(textOf(await call("ground_impact", { subject: "nothing" }))).toBe("No dependents found.\n\n[]");
  });
});

// ---- option threading --------------------------------------------------------

describe("option threading", () => {
  it("omits undefined options entirely rather than passing explicit undefined", async () => {
    await call("ground_recall", { query: "x" });
    expect(lastArgs("recall")![1]).toEqual({});
  });

  it("passes through every recall option that was supplied", async () => {
    await call("ground_recall", {
      query: "x",
      limit: 5,
      project: "grounded",
      sources: ["fact", "doc"],
      lexicalOnly: true,
      scopes: ["global", "administration"],
    });
    expect(lastArgs("recall")![1]).toEqual({
      limit: 5,
      project: "grounded",
      sources: ["fact", "doc"],
      lexicalOnly: true,
      scopes: ["global", "administration"],
    });
  });

  it("ground_brief defaults to markdown and returns text, not JSON", async () => {
    const body = textOf(await call("ground_brief", {}));
    expect(body).toBe("# brief\n\nrecent work");
    expect((lastArgs("brief")![0] as { format: string }).format).toBe("markdown");
  });

  it("ground_brief format=json returns the structured brief", async () => {
    const body = textOf(await call("ground_brief", { format: "json", timezone: "America/Chicago" }));
    expect(JSON.parse(body).startupNote).toBe("note");
    expect(lastArgs("brief")![0]).toMatchObject({ format: "json", timezone: "America/Chicago" });
  });

  it("ground_brief falls back to startupNote when the store returns no text", async () => {
    impls.brief = () => ({ startupNote: "fallback" });
    expect(textOf(await call("ground_brief", {}))).toBe("fallback");
  });

  it("ground_facts_list maps status: default→active, all→unset, archived→archived", async () => {
    await call("ground_facts_list", {});
    expect(lastArgs("factsList")![0]).toEqual({ status: "active" });
    calls = [];
    await call("ground_facts_list", { status: "all" });
    expect(lastArgs("factsList")![0]).toEqual({ status: undefined });
    calls = [];
    await call("ground_facts_list", { status: "archived", scope: "project:x" });
    expect(lastArgs("factsList")![0]).toEqual({ status: "archived", scope: "project:x" });
  });

  it("ground_vision_get loads the global vision, and the project one only when asked", async () => {
    await call("ground_vision_get", {});
    expect(calls.filter((c) => c.method === "visionGet").map((c) => c.args[0])).toEqual(["global"]);
    calls = [];
    const body = textOf(await call("ground_vision_get", { project: "grounded" }));
    expect(calls.filter((c) => c.method === "visionGet").map((c) => c.args[0])).toEqual([
      "global",
      "project:grounded",
    ]);
    expect(JSON.parse(body)).toHaveProperty("project");
  });

  it("ground_vision_set tags the write with source: mcp", async () => {
    await call("ground_vision_set", { details: "ship it", summary: "ship", scope: "project:x" });
    expect(lastArgs("visionSet")![0]).toEqual({
      details: "ship it",
      summary: "ship",
      scope: "project:x",
      source: "mcp",
    });
  });

  it("ground_session_update forwards the patch verbatim minus the id", async () => {
    await call("ground_session_update", { id: 900, summary: "fixed", tags: ["a"] });
    expect(lastArgs("sessionsUpdate")![0]).toBe(900);
    expect(lastArgs("sessionsUpdate")![1]).toEqual({ summary: "fixed", tags: ["a"] });
  });

  it("delete tools report the outcome alongside the id", async () => {
    expect(JSON.parse(textOf(await call("ground_facts_delete", { id: 7 })))).toEqual({ deleted: true, id: 7 });
    expect(JSON.parse(textOf(await call("ground_session_delete", { id: 9 })))).toEqual({ deleted: true, id: 9 });
  });

  it("ground_docs_prune defaults to marking missing, never deleting", async () => {
    await call("ground_docs_prune", {});
    expect(lastArgs("docsPrune")![0]).toEqual({});
    calls = [];
    await call("ground_docs_prune", { remove: true });
    expect(lastArgs("docsPrune")![0]).toEqual({ remove: true });
  });
});

// ---- write-time delivery feedback --------------------------------------------

describe("fact write delivery feedback", () => {
  it("attaches a delivery rank to a created fact", async () => {
    const body = JSON.parse(textOf(await call("ground_facts_add", { fact: "port is 5433" })));
    expect(body.id).toBe(7);
    expect(body.delivery).toBeTruthy();
    expect(body.delivery.rank).toBe(2);
    expect(body.delivery.ofActive).toBe(40);
  });

  it("warns when the new fact ranks outside the typical consumer limit", async () => {
    impls.factsDeliveryRank = () => ({ rank: 99, ofActive: 120 });
    const body = JSON.parse(textOf(await call("ground_facts_add", { fact: "buried" })));
    expect(JSON.stringify(body.delivery)).toMatch(/warn/i);
  });

  it("omits delivery when the store has no rank for the row (e.g. archived)", async () => {
    impls.factsDeliveryRank = () => null;
    const body = JSON.parse(textOf(await call("ground_facts_add", { fact: "archived", status: "archived" })));
    expect(body).not.toHaveProperty("delivery");
  });

  it("scans every active fact when computing the pinned reserve, not the list default", async () => {
    await call("ground_facts_add", { fact: "x" });
    expect(lastArgs("factsList")![0]).toEqual({ status: "active", limit: 100_000 });
  });

  it("ground_facts_update reports delivery the same way as add", async () => {
    const body = JSON.parse(textOf(await call("ground_facts_update", { id: 7, pinned: true })));
    expect(body.delivery.rank).toBe(2);
    expect(lastArgs("factsUpdate")![1]).toEqual({ pinned: true });
  });
});

// ---- vision write cap --------------------------------------------------------

describe("vision write cap", () => {
  it("rejects an over-cap details write instead of truncating at delivery", async () => {
    const cap = visionCapChars(400);
    const r = await call("ground_vision_set", { details: "x".repeat(cap + 1) });
    expect(r.isError).toBe(true);
    expect(calls.some((c) => c.method === "visionSet")).toBe(false);
  });

  it("accepts a write exactly at the cap", async () => {
    const cap = visionCapChars(400);
    const r = await call("ground_vision_set", { details: "x".repeat(cap) });
    expect(r.isError).toBeFalsy();
    expect(calls.some((c) => c.method === "visionSet")).toBe(true);
  });

  it("derives the cap from the configured vision reserve", async () => {
    // a bigger reserve must permit a bigger write
    const server = createServer(store, { visionReserveTok: 4000 });
    const c = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), c.connect(ct)]);
    const over400 = "x".repeat(visionCapChars(400) + 1);
    const r = (await c.callTool({ name: "ground_vision_set", arguments: { details: over400 } })) as CallToolResult;
    expect(r.isError).toBeFalsy();
  });
});

// ---- error mapping -----------------------------------------------------------

describe("error mapping", () => {
  it("maps a GroundedError to a code-prefixed tool error, not a transport failure", async () => {
    impls.recall = () => {
      throw new GroundedError("sqlite file is locked", "STORE_UNAVAILABLE");
    };
    const r = await call("ground_recall", { query: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("STORE_UNAVAILABLE: sqlite file is locked");
  });

  it("maps a plain Error to its message", async () => {
    impls.health = () => {
      throw new Error("ollama unreachable");
    };
    const r = await call("ground_health", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("ollama unreachable");
  });

  it("stringifies a non-Error throw rather than crashing the transport", async () => {
    impls.docsPrune = () => {
      throw "just a string";
    };
    const r = await call("ground_docs_prune", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("just a string");
  });

  it("survives an error and keeps serving the next call on the same connection", async () => {
    impls.health = () => {
      throw new Error("boom");
    };
    expect((await call("ground_health", {})).isError).toBe(true);
    impls = {};
    const r = await call("ground_health", {});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r)).storage.adapter).toBe("sqlite");
  });
});
