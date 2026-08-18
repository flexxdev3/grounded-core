# @grounded/ui

The Grounded console — a small Preact web app (not a chat app) for inspecting and managing your
cabinet. `@grounded/api` serves its built assets from the same origin as the API.

[Grounded](https://github.com/grounded/grounded) is a self-hosted, source-cited memory layer for AI
agents: a shared vision, explicit facts, a session work-log, indexed docs, hybrid recall, and startup
briefs. Apache-2.0, no telemetry.

## Install

You normally get it for free: it is a dependency of `@grounded/api`, and `grounded install` puts both
in place. Installing it alone only gives you the static assets:

```sh
npm install @grounded/ui
```

## Usage

Run the service and open the console:

```sh
grounded install        # or: grounded-api
# console: http://127.0.0.1:7437/
```

Serving it yourself from a Hono app:

```js
import { loadConfig, openStore } from "@grounded/core";
import { createApp, serveUi, resolveUiDist } from "@grounded/api";

const app = createApp(await openStore(loadConfig()));
const dist = resolveUiDist();          // resolves @grounded/ui/dist, or null if unbuilt
if (dist) serveUi(app, dist);          // registered after the API routes so JSON endpoints win
```

Set `GROUNDED_API_UI=0` to run the API headless with no console.

## Surface

This package ships built assets, not a JS API. Its only export map entry is `./dist/*` — the
published `dist/` holds `index.html` plus hashed `assets/*`. The bundle is built with a **relative**
base (`base: "./"`), so it stays portable under any mount path.

Views mirror the API one-for-one:

- **Overview** — what's in the cabinet at a glance
- **Recall** — hybrid search across facts, sessions, and docs, every hit cited
- **Vision** — the global vision and one per project
- **Facts** — add/edit/delete, pin, scope, importance, archive; shows delivery rank
- **Sessions** — the chronological work-log timeline
- **Docs** — source browser, status, re-ingest, missing/stale
- **Brief** — preview the startup context an agent will receive
- **Health** — storage + embedding + record counts

It talks to the API through [`@grounded/client`](https://www.npmjs.com/package/@grounded/client), so
it works against a local or remote `grounded-api` with no server-side rendering.

## Develop

```sh
pnpm --filter @grounded/ui dev       # vite dev server
pnpm --filter @grounded/ui build     # emits dist/
```

## Links

- Repo README: <https://github.com/grounded/grounded#readme>
- License: Apache-2.0
