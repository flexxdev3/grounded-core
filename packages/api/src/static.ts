import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { createRequire } from "node:module";
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

/** Resolve the built @grounded/ui dist directory, or null if the package
 *  (or its build) is absent — the API then runs headless (no console). */
export function resolveUiDist(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const indexHtml = require.resolve("@grounded/ui/dist/index.html");
    return existsSync(indexHtml) ? join(indexHtml, "..") : null;
  } catch {
    return null;
  }
}

/** Serve the built console from `distDir`: index.html at "/", hashed assets
 *  under "/assets/*". Registered AFTER the API routes so JSON endpoints win. */
export function serveUi(app: Hono, distDir: string): void {
  const send = async (relRaw: string, c: Context) => {
    // strip query, normalize, and refuse traversal outside distDir
    const rel = normalize(relRaw.split("?")[0]!).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = join(distDir, rel);
    if (!file.startsWith(distDir) || !existsSync(file)) return c.notFound();
    const body = await readFile(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const cache = rel.startsWith("assets/")
      ? "public, max-age=31536000, immutable" // content-hashed
      : "no-cache";
    return c.body(body as unknown as ArrayBuffer, 200, { "content-type": type, "cache-control": cache });
  };

  app.get("/", (c) => send("index.html", c));
  app.get("/index.html", (c) => send("index.html", c));
  app.get("/assets/*", (c) => send(c.req.path.replace(/^\/+/, ""), c));
  app.get("/favicon.ico", (c) => send("favicon.ico", c));
}
