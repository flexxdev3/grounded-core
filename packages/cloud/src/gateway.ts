import { Hono } from "hono";
import type { Hono as HonoApp } from "hono";
import { createApp } from "@grounded/api";
import type pg from "pg";
import type { CloudConfig } from "./config.js";
import { createAuth, sessionFromHeaders } from "./auth.js";
import { TenantManager } from "./tenants.js";
import { TokenManager } from "./tokens.js";
import { accountRoutes } from "./account.js";
import { resolveCloudUiDist, serveCloudUi } from "./static.js";

export interface Gateway {
  app: HonoApp;
  tenants: TenantManager;
  close(): Promise<void>;
}

/** Methods that mutate state — gated on the token's `write` scope. */
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Enforce `api_tokens.scopes` for a bearer-token request. Returns a 403 error body
 * (matching the `{ error, code }` shape `packages/api`'s onError uses) if the
 * token's scopes don't cover the request, or null if the request may proceed.
 * Missing `read` blocks everything (the deliberate-revocation case); missing
 * `write` only blocks mutating methods. Session-authenticated (browser) requests
 * aren't scoped — this only applies to `grnd_…` API tokens.
 */
function scopeCheck(scopes: string[], method: string): { error: string; code: string } | null {
  if (!scopes.includes("read")) {
    return { error: 'token lacks the "read" scope', code: "FORBIDDEN" };
  }
  if (MUTATING_METHODS.has(method) && !scopes.includes("write")) {
    return { error: 'token lacks the "write" scope', code: "FORBIDDEN" };
  }
  return null;
}

/**
 * Assemble the full cloud gateway:
 *   /auth/*     — better-auth (signup/login/oauth/session)
 *   /account/*  — control-plane (cabinet, tokens, connect, delete) [session-gated]
 *   /api/*      — the FULL self-hosted Grounded API, per-tenant [token OR session]
 *
 * /api/* is the whole point: a hosted user's agents call the exact same 18 routes a
 * self-hoster runs, only the base URL + auth differ. We resolve the tenant, fetch its
 * cached Store, and delegate to a memoized createApp(store) — the open-core API, unchanged.
 */
export function createGateway(pool: pg.Pool, cfg: CloudConfig): Gateway {
  const auth = createAuth(pool, cfg);
  const apiCache = new Map<string, HonoApp>(); // schema -> createApp instance
  const tenants = new TenantManager(pool, cfg, (schema) => apiCache.delete(schema));
  const tokens = new TokenManager(pool, cfg);

  const app = new Hono();

  // better-auth owns everything under /auth.
  app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

  // Control-plane account API.
  app.route("/account", accountRoutes({ cfg, auth, tenants, tokens }));

  // Per-tenant Grounded API.
  app.all("/api/*", async (c) => {
    // Resolve tenant: API token (agents) takes precedence, else browser session (console).
    let schema: string | null = null;

    const authz = c.req.header("authorization") ?? "";
    const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (bearer.startsWith("grnd_")) {
      const verified = await tokens.verify(bearer);
      if (!verified) return c.json({ error: "invalid token", code: "UNAUTHORIZED" }, 401);
      const forbidden = scopeCheck(verified.scopes, c.req.method);
      if (forbidden) return c.json(forbidden, 403);
      const cabinet = await tenants.cabinetById(verified.cabinetId);
      schema = cabinet?.schema ?? null;
    } else {
      const sess = await sessionFromHeaders(auth, c.req.raw.headers);
      if (sess) {
        const cabinet = await tenants.cabinetByUser(sess.userId);
        schema = cabinet?.schema ?? null;
      }
    }

    if (!schema) return c.json({ error: "unauthorized", code: "UNAUTHORIZED" }, 401);

    // Get-or-build the tenant's API app (memoized alongside the Store's LRU).
    let tenantApi = apiCache.get(schema);
    if (!tenantApi) {
      const store = await tenants.storeForSchema(schema);
      tenantApi = createApp(store); // no per-app token — auth already happened at the gateway
      apiCache.set(schema, tenantApi);
    }

    // Delegate: strip the /api prefix so the sub-app sees /recall, /facts, …
    const url = new URL(c.req.raw.url);
    url.pathname = url.pathname.replace(/^\/api/, "") || "/";
    const subReq = new Request(url, c.req.raw);
    return tenantApi.fetch(subReq);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // The account UI SPA — served last so every API prefix above wins. Skipped
  // (headless) when no build is present.
  const uiDist = resolveCloudUiDist();
  if (uiDist) serveCloudUi(app, uiDist);

  return {
    app,
    tenants,
    close: async () => {
      await tenants.closeAll();
      await pool.end();
    },
  };
}
