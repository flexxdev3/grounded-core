import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import type { Context, Hono } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * Resolve the built @grounded/cloud-web dist directory (the account UI). Falls
 * back to `<cloud-pkg>/web/dist` relative to this compiled module. Override with
 * `CLOUD_UI_DIST`. Returns null if no build is present — the gateway then runs
 * headless (API only), which is fine for tests / bare deploys.
 */
export function resolveCloudUiDist(): string | null {
  const envDir = process.env.CLOUD_UI_DIST;
  if (envDir && existsSync(join(envDir, "index.html"))) return envDir;
  // compiled at packages/cloud/dist/static.js → ../web/dist
  const here = dirname(fileURLToPath(import.meta.url));
  const guess = join(here, "..", "web", "dist");
  return existsSync(join(guess, "index.html")) ? guess : null;
}

/**
 * Serve the account UI SPA from `distDir`. The bundle is public (the app renders
 * its own auth gate; data stays gated by /account/* + /api/*). Registered AFTER
 * the gateway's API routes so /auth, /account, /api always win. Unknown GET paths
 * fall through to index.html so client routing / deep links resolve.
 */
export function serveCloudUi(app: Hono, distDir: string): void {
  const send = async (relRaw: string, c: Context): Promise<Response> => {
    const rel = normalize(relRaw.split("?")[0]!).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = join(distDir, rel);
    if (!file.startsWith(distDir) || !existsSync(file)) return c.notFound();
    const body = await readFile(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const cache = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return c.body(body as unknown as ArrayBuffer, 200, { "content-type": type, "cache-control": cache });
  };

  app.get("/", (c) => send("index.html", c));
  app.get("/index.html", (c) => send("index.html", c));
  app.get("/assets/*", (c) => send(c.req.path.replace(/^\/+/, ""), c));
  app.get("/favicon.ico", (c) => send("favicon.ico", c));

  // SPA fallback — any other non-API GET returns the shell.
  app.get("*", async (c) => {
    const p = c.req.path;
    if (p.startsWith("/api") || p.startsWith("/auth") || p.startsWith("/account") || p.startsWith("/healthz")) {
      return c.notFound();
    }
    const asset = await send(p.replace(/^\/+/, ""), c);
    if (asset.status !== 404) return asset;
    return send("index.html", c);
  });
}
