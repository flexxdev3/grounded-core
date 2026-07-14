import { createClient, GroundedHttpError } from "@grounded/client";

// Resolve the API base at RUNTIME so one build serves both mounts: standalone
// (console served by grounded-api at the origin root → "") and embedded in the
// Grounded Cloud gateway (only `/api/*` exists there → "/api"). A build-time env
// can't vary per host, so the host injects the base at load:
//   1. window.__GROUNDED_BASE__ = "/api"           (script the host sets)
//   2. <meta name="grounded-base" content="/api">  (server-rendered)
//   3. import.meta.env.VITE_GROUNDED_BASE           (standalone build/dev)
//   4. "" — same-origin root (default; console served by grounded-api)
function resolveBase(): string {
  if (typeof window !== "undefined") {
    const g = (window as unknown as { __GROUNDED_BASE__?: unknown }).__GROUNDED_BASE__;
    if (typeof g === "string") return g;
    const meta = document.querySelector('meta[name="grounded-base"]')?.getAttribute("content");
    if (meta) return meta;
  }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_GROUNDED_BASE;
  if (typeof env === "string" && env) return env;
  return "";
}

export const api = createClient({ baseUrl: resolveBase() });

export { GroundedHttpError };

/** Human-readable message for any thrown error (HTTP or network). */
export function errMessage(e: unknown): string {
  if (e instanceof GroundedHttpError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
