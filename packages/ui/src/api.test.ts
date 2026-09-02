/**
 * The console ships as ONE build served from two different mounts: standalone at
 * the origin root (grounded-api) and under /api in the Cloud gateway. The base
 * URL is therefore resolved at RUNTIME, and getting that wrong points every
 * request at a 404. These tests drive the resolution through the real client by
 * observing the URL that fetch is handed.
 *
 * No DOM library: `window`/`document` are stubbed directly, which is all
 * resolveBase() touches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const g = globalThis as unknown as Record<string, unknown>;

/** Install a minimal window/document pair; `meta` seeds <meta name="grounded-base">. */
function installDom(opts: { base?: unknown; meta?: string | null } = {}) {
  const win: Record<string, unknown> = {};
  if ("base" in opts) win.__GROUNDED_BASE__ = opts.base;
  g.window = win;
  g.document = {
    querySelector(sel: string) {
      if (sel === 'meta[name="grounded-base"]' && opts.meta != null) {
        return { getAttribute: () => opts.meta };
      }
      return null;
    },
  };
}

function clearDom() {
  delete g.window;
  delete g.document;
}

/** Capture the URL + init of every fetch the module makes. */
let fetched: { url: string; init: RequestInit }[] = [];
let respond: () => Response = () => new Response("{}", { status: 200 });

function installFetch() {
  fetched = [];
  g.fetch = vi.fn(async (url: string, init: RequestInit) => {
    fetched.push({ url: String(url), init });
    return respond();
  });
}

/** Fresh module — `api` is constructed once at module scope from resolveBase(). */
async function loadApi() {
  vi.resetModules();
  return import("./api.js");
}

beforeEach(() => {
  installFetch();
  respond = () => new Response("{}", { status: 200 });
  vi.unstubAllEnvs();
  clearDom();
});

afterEach(() => {
  clearDom();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ---- base URL resolution -----------------------------------------------------

describe("base URL resolution", () => {
  it("defaults to same-origin root when nothing declares a base", async () => {
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/health");
  });

  it("prefers window.__GROUNDED_BASE__ (the host-injected script)", async () => {
    installDom({ base: "/api" });
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/api/health");
  });

  it("accepts an empty-string __GROUNDED_BASE__ as an explicit root declaration", async () => {
    installDom({ base: "", meta: "/should-not-win" });
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/health");
  });

  it("ignores a non-string __GROUNDED_BASE__ and falls through to the meta tag", async () => {
    installDom({ base: 42, meta: "/api" });
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/api/health");
  });

  it("falls back to the server-rendered <meta name=\"grounded-base\">", async () => {
    installDom({ meta: "/api" });
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/api/health");
  });

  // NOT TESTABLE HERE: tier 3 reads `import.meta.env.VITE_GROUNDED_BASE`, which
  // Vite freezes per module at transform time. vi.stubEnv() only patches the
  // *test* module's import.meta.env, not the one baked into api.ts, so the env
  // tier cannot be exercised without either a build-time define (which would
  // apply to every test in this file) or a source change to api.ts.
  it.skip("falls back to VITE_GROUNDED_BASE for a standalone build/dev server", () => {});

  it("runtime injection beats the server-rendered meta tag", async () => {
    installDom({ base: "/api", meta: "/should-not-win" });
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/api/health");
  });

  it("an absent meta tag falls through to the same-origin default", async () => {
    installDom({ meta: null });
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/health");
  });

  it("strips a trailing slash so paths never double up", async () => {
    installDom({ base: "/api/" });
    const { api } = await loadApi();
    await api.health();
    expect(fetched[0]!.url).toBe("/api/health");
  });

  it("applies the resolved base to every verb, not just health", async () => {
    installDom({ base: "/api" });
    const { api } = await loadApi();
    respond = () => new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    await api.recall("q");
    await api.facts.list({ limit: 5 });
    await api.get("doc:12");
    expect(fetched.map((f) => f.url)).toEqual([
      "/api/recall",
      "/api/facts?limit=5",
      "/api/get/doc:12",
    ]);
  });
});

// ---- envelope parsing --------------------------------------------------------

describe("response envelope", () => {
  beforeEach(() => {
    installDom({ base: "" });
  });

  it("surfaces the {data, meta} envelope with available/truncated intact", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          data: [{ typedId: "doc:12", title: "network.md" }],
          meta: {
            returned: 1,
            available: 42,
            truncated: true,
            bySource: { doc: { returned: 1, available: 42 } },
          },
        }),
        { status: 200 },
      );
    const { api } = await loadApi();
    const res = await api.recall("arch1", { limit: 1 });
    expect(res.data).toHaveLength(1);
    // `available` is the true match count — never data.length
    expect(res.meta.available).toBe(42);
    expect(res.meta.truncated).toBe(true);
    expect(res.meta.bySource!.doc).toEqual({ returned: 1, available: 42 });
  });

  it("sends the query in the POST body as JSON with a content-type", async () => {
    respond = () => new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    const { api } = await loadApi();
    await api.recall("arch1", { limit: 30, sources: ["fact"], lexicalOnly: true });
    const { init } = fetched[0]!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "arch1",
      limit: 30,
      sources: ["fact"],
      lexicalOnly: true,
    });
  });

  it("omits an undefined option from the query string rather than sending 'undefined'", async () => {
    respond = () => new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    const { api } = await loadApi();
    await api.facts.list({});
    expect(fetched[0]!.url).toBe("/facts");
  });

  it("tolerates an empty body on a 204-style response", async () => {
    respond = () => new Response("", { status: 200 });
    const { api } = await loadApi();
    await expect(api.health()).resolves.toBeUndefined();
  });
});

// ---- error surface -----------------------------------------------------------

describe("error surface", () => {
  beforeEach(() => {
    installDom({ base: "" });
  });

  it("raises a GroundedHttpError carrying the API's status and code", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "limit must be a positive integer", code: "BAD_REQUEST" }), {
        status: 400,
      });
    const { api, GroundedHttpError } = await loadApi();
    await expect(api.health()).rejects.toBeInstanceOf(GroundedHttpError);
    const err = await api.health().catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toBe("limit must be a positive integer");
  });

  it("falls back to a generic code/message when the body carries neither", async () => {
    respond = () => new Response("{}", { status: 502 });
    const { api } = await loadApi();
    const err = await api.health().catch((e) => e);
    expect(err.code).toBe("HTTP_ERROR");
    expect(err.message).toBe("HTTP 502");
  });

  it("errMessage renders an HTTP error as the API's own message", async () => {
    respond = () => new Response(JSON.stringify({ error: "fact not found", code: "NOT_FOUND" }), { status: 404 });
    const { api, errMessage } = await loadApi();
    const err = await api.health().catch((e) => e);
    expect(errMessage(err)).toBe("fact not found");
  });

  it("errMessage renders a network failure (no response at all)", async () => {
    const { errMessage } = await loadApi();
    expect(errMessage(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("errMessage stringifies a non-Error throw instead of rendering [object Object]", async () => {
    const { errMessage } = await loadApi();
    expect(errMessage("plain string")).toBe("plain string");
    expect(errMessage(null)).toBe("null");
  });
});
