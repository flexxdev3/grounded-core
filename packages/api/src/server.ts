import { serve } from "@hono/node-server";
import type { Store } from "@grounded/core/contract";
import type { ResolvedBudget } from "@grounded/core/delivery";
import { createApp } from "./app.js";
import type { EmbeddingsAddon } from "./addons.js";
import type { Databox } from "@grounded/databox";
import { resolveUiDist, serveUi } from "./static.js";
import { createSharingController, sharingInternalHeader, type SharingController } from "./sharing.js";
import { defaultHome } from "@grounded/core";
import { join } from "node:path";

export interface StartServerOptions {
  store: Store;
  token?: string;
  port?: number;
  host?: string;
  /** serve the built console UI (default: true when @grounded/ui is present). */
  ui?: boolean;
  /**
   * The resolved Context Budget Contract table — `resolveBudget(config)`. ONE
   * object carrying every lane's read reserve and the write caps derived from
   * it; the bin threads it from the loaded config so the running service
   * enforces, and publishes on /health, exactly what config.toml says.
   *
   * The three per-lane options below predate it and still work (they are
   * folded into the table), but `budget` wins when both are supplied.
   */
  budget?: ResolvedBudget;
  /** `cfg.delivery.typicalFactLimit` — the rank threshold the fact-write routes
   *  use to decide whether a new fact warrants a "you will not be seen" warning.
   *  Threaded from the resolved config by the bin; omitting it falls back to the
   *  shipped default rather than silently disabling the signal. */
  typicalFactLimit?: number;
  /** `cfg.brief.reserve.facts` — the facts reserve budget (tokens) the
   *  pinned-reserve write-time warning checks the pinned set's rendered size
   *  against. Threaded from the resolved config by the bin, same pattern as
   *  `typicalFactLimit`. */
  factsReserveTok?: number;
  /** `cfg.brief.reserve.vision` — the vision reserve budget (tokens). The
   *  POST /vision validator turns it into the char cap it rejects over-long
   *  vision against, so the write limit tracks the read budget. Threaded from
   *  the resolved config by the bin, same pattern as `factsReserveTok`. */
  visionReserveTok?: number;
  embeddingsAddon?: EmbeddingsAddon;
  /** the Databox addition, when `[databox] enabled`. */
  databox?: Databox;
  /** Enable opt-in, paired LAN sharing support. Defaults on for loopback hosts. */
  sharing?: boolean;
  /** Secondary temporary listener. Defaults to the main port + 1. */
  sharingPort?: number;
}

export interface RunningServer {
  url: string;
  /** true when the console UI is being served at `url`. */
  ui: boolean;
  sharing?: SharingController;
  close: () => Promise<void>;
}

/** Boot grounded-api on a real port. Shared by the `grounded-api` bin and
 *  `ground ui`. Serves the console from the same origin unless disabled. */
export function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const port = opts.port ?? 7437;
  const host = opts.host ?? "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const sharingEnabled = opts.sharing ?? loopback;
  const internalHeader = sharingInternalHeader();
  let app!: ReturnType<typeof createApp>;
  const sharing = sharingEnabled
    ? createSharingController({
        fetch: (request) => app.fetch(request),
        port: opts.sharingPort ?? port + 1,
        internalHeader,
        stateFile: join(defaultHome(), "sharing.json"),
      })
    : undefined;

  app = createApp(opts.store, {
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.typicalFactLimit !== undefined
      ? { typicalFactLimit: opts.typicalFactLimit }
      : {}),
    ...(opts.factsReserveTok !== undefined
      ? { factsReserveTok: opts.factsReserveTok }
      : {}),
    ...(opts.embeddingsAddon ? { embeddingsAddon: opts.embeddingsAddon } : {}),
    ...(opts.databox ? { databox: opts.databox } : {}),
    ...(sharing ? { sharing, sharingInternalHeader: internalHeader } : {}),
    ...(opts.visionReserveTok !== undefined
      ? { visionReserveTok: opts.visionReserveTok }
      : {}),
  });

  const distDir = opts.ui === false ? null : resolveUiDist();
  if (distDir) serveUi(app, distDir);

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, async (info) => {
      try {
        await sharing?.initialize();
      } catch (error) {
        server.close();
        reject(error);
        return;
      }
      resolve({
        url: `http://${host}:${info.port}`,
        ui: Boolean(distDir),
        ...(sharing ? { sharing } : {}),
        close: async () => {
          await sharing?.close();
          await new Promise<void>((res) => {
            server.close(() => res());
          });
        },
      });
    });
  });
}
