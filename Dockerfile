# Grounded — self-hosted continuity API (grounded-api + console)
# Builds the pnpm monorepo and runs the REST/console server headless-capable.
# Config comes from a cabinet mounted at GROUNDED_HOME (default /cabinet).

# ---- build ----
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Build leaves first so workspace entries (client/dist) exist before vite (ui)
# resolves them; a bare `pnpm -r build` doesn't reliably topo-order them fresh.
RUN pnpm --filter @grounded/core build \
  && pnpm --filter @grounded/client build \
  && pnpm -r build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
# Detection label — `grounded` installer and `detect()` filter on this so a
# double-install is caught even for a hand-run container.
LABEL com.grounded.managed="true"
RUN corepack enable
WORKDIR /app
# Whole tree incl. the pnpm symlink farm + built dist (native better-sqlite3
# is ABI-compatible: same base image + arch as the build stage).
COPY --from=build /app /app
ENV NODE_ENV=production \
    GROUNDED_HOME=/cabinet \
    GROUNDED_API_HOST=0.0.0.0 \
    GROUNDED_API_PORT=7437 \
    GROUNDED_API_UI=1
EXPOSE 7437
CMD ["node", "packages/api/dist/bin.js"]
