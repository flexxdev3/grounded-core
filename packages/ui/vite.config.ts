import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The console is served by @grounded/api (Hono serveStatic) as a single process,
// so it must load from a relative base — never an absolute "/" — to stay portable
// under any mount path. Dev proxies /api and friends to a locally-run grounded-api.
const API_TARGET = process.env.GROUNDED_API_URL ?? "http://127.0.0.1:7437";
const API_PATHS = ["/health", "/facts", "/sessions", "/docs", "/recall", "/brief", "/get", "/openapi.json"];

export default defineConfig({
  base: "./",
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 7438,
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [p, { target: API_TARGET, changeOrigin: true }]),
    ),
  },
});
