import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The cloud UI is served by the @grounded/cloud gateway (Hono, one process on OVH)
// as static assets under a relative base — never absolute "/" — so it stays portable
// under any mount. In `vite dev` we proxy the gateway's live routes to a locally-run
// grounded-cloud so the SPA can talk to real auth/account/tenant APIs during dev.
const GW_TARGET = process.env.CLOUD_GATEWAY_URL ?? "http://127.0.0.1:8088";
const GW_PATHS = ["/auth", "/account", "/api"];

export default defineConfig({
  base: "./",
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 8089,
    proxy: Object.fromEntries(
      GW_PATHS.map((p) => [p, { target: GW_TARGET, changeOrigin: true }]),
    ),
  },
});
