import { serve } from "@hono/node-server";
import type { Store } from "@grounded/core/contract";
import { createApp } from "./app.js";
import { resolveUiDist, serveUi } from "./static.js";

export interface StartServerOptions {
  store: Store;
  token?: string;
  port?: number;
  host?: string;
  /** serve the built console UI (default: true when @grounded/ui is present). */
  ui?: boolean;
  /** `cfg.delivery.typicalFactLimit` — the rank threshold the fact-write routes
   *  use to decide whether a new fact warrants a "you will not be seen" warning.
   *  Threaded from the resolved config by the bin; omitting it falls back to the
   *  shipped default rather than silently disabling the signal. */
  typicalFactLimit?: number;
}

export interface RunningServer {
  url: string;
  /** true when the console UI is being served at `url`. */
  ui: boolean;
  close: () => Promise<void>;
}

/** Boot grounded-api on a real port. Shared by the `grounded-api` bin and
 *  `ground ui`. Serves the console from the same origin unless disabled. */
export function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const app = createApp(opts.store, {
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.typicalFactLimit !== undefined
      ? { typicalFactLimit: opts.typicalFactLimit }
      : {}),
  });

  const distDir = opts.ui === false ? null : resolveUiDist();
  if (distDir) serveUi(app, distDir);

  const port = opts.port ?? 7437;
  const host = opts.host ?? "127.0.0.1";

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      resolve({
        url: `http://${host}:${info.port}`,
        ui: Boolean(distDir),
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
