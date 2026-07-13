import { Hono } from "hono";
import type { Context } from "hono";
import type { CloudConfig } from "./config.js";
import type { Auth } from "./auth.js";
import { sessionFromHeaders } from "./auth.js";
import type { TenantManager } from "./tenants.js";
import { TokenManager } from "./tokens.js";

interface Deps {
  cfg: CloudConfig;
  auth: Auth;
  tenants: TenantManager;
  tokens: TokenManager;
}

type Ctx = { userId: string; email: string };

/** Build the hosted-cabinet API base URL an agent points at. */
function apiBase(cfg: CloudConfig): string {
  return `${cfg.baseUrl.replace(/\/$/, "")}/api`;
}

/** Ready-to-paste connect snippets for a hosted cabinet (URL + token). */
function connectSnippets(cfg: CloudConfig, token: string): Record<string, string> {
  const url = apiBase(cfg);
  return {
    hook: [
      "# SessionStart hook — startup brief from your hosted Grounded cabinet",
      `export GROUNDED_URL="${url}"`,
      `export GROUNDED_TOKEN="${token}"`,
      `curl -s -H "Authorization: Bearer $GROUNDED_TOKEN" \\`,
      `  -X POST "$GROUNDED_URL/brief" -H 'content-type: application/json' \\`,
      `  -d '{"format":"markdown"}' | jq -r '.text'`,
    ].join("\n"),
    curl: [
      `# Recall from your cabinet`,
      `curl -s -H "Authorization: Bearer ${token}" \\`,
      `  -X POST "${url}/recall" -H 'content-type: application/json' \\`,
      `  -d '{"query":"what did we decide about auth"}'`,
    ].join("\n"),
    client: [
      `import { createClient } from "@grounded/client";`,
      `const grounded = createClient({`,
      `  baseUrl: "${url}",`,
      `  token: "${token}",`,
      `});`,
      `await grounded.brief({ format: "markdown" });`,
    ].join("\n"),
  };
}

export function accountRoutes(d: Deps): Hono {
  const app = new Hono();

  // Per-handler session gate — returns the ctx, or a 401 Response to short-circuit.
  const gate = async (c: Context): Promise<Ctx | Response> => {
    const sess = await sessionFromHeaders(d.auth, c.req.raw.headers);
    if (!sess) return c.json({ error: "unauthorized", code: "UNAUTHORIZED" }, 401);
    return sess;
  };

  // Current user + whether a cabinet exists.
  app.get("/me", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const cabinet = await d.tenants.cabinetByUser(g.userId);
    return c.json({ user: { id: g.userId, email: g.email }, cabinet });
  });

  // Cabinet status: endpoint, plan, live counts. Provisions on first call (onboarding).
  app.get("/cabinet", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const cabinet = await d.tenants.provision(g.userId);
    const store = await d.tenants.storeForSchema(cabinet.schema);
    const health = await store.health();
    return c.json({
      cabinet: { id: cabinet.id, plan: cabinet.plan, status: cabinet.status, shard: cabinet.shard },
      endpoint: apiBase(d.cfg),
      health,
    });
  });

  // ---- API tokens ----
  app.get("/tokens", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const cabinet = await d.tenants.provision(g.userId);
    return c.json({ tokens: await d.tokens.list(cabinet.id) });
  });

  app.post("/tokens", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const cabinet = await d.tenants.provision(g.userId);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const name = (body.name ?? "").trim() || "default";
    const issued = await d.tokens.issue(cabinet.id, name);
    // The secret is shown ONCE here; also hand back connect snippets prefilled with it.
    return c.json({ token: issued.row, secret: issued.secret, connect: connectSnippets(d.cfg, issued.secret) }, 201);
  });

  app.delete("/tokens/:id", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const cabinet = await d.tenants.provision(g.userId);
    const ok = await d.tokens.revoke(cabinet.id, c.req.param("id"));
    if (!ok) return c.json({ error: "token not found", code: "NOT_FOUND" }, 404);
    return c.json({ revoked: true, id: c.req.param("id") });
  });

  // Connect snippets with a placeholder token (real one comes from token creation).
  app.get("/connect", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    await d.tenants.provision(g.userId);
    return c.json({ endpoint: apiBase(d.cfg), snippets: connectSnippets(d.cfg, "grnd_<your-token>") });
  });

  // Danger zone — delete account + cabinet. Export first is enforced client-side.
  app.delete("/", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const cabinet = await d.tenants.cabinetByUser(g.userId);
    if (cabinet) await d.tenants.destroy(cabinet);
    // better-auth user deletion (removes user/session/account rows).
    const api = d.auth.api as { deleteUser?: (a: unknown) => Promise<unknown> };
    await api.deleteUser?.({ headers: c.req.raw.headers, body: {} }).catch(() => {});
    return c.json({ deleted: true });
  });

  return app;
}
