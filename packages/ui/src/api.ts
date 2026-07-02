import { createClient, GroundedHttpError } from "@grounded/client";

// Same-origin: the console is served by grounded-api, so a relative base points
// every request back at the API that served this page. In `vite dev`, the dev
// server proxies these paths to a locally-running grounded-api (see vite.config).
export const api = createClient({ baseUrl: "" });

export { GroundedHttpError };

/** Human-readable message for any thrown error (HTTP or network). */
export function errMessage(e: unknown): string {
  if (e instanceof GroundedHttpError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
