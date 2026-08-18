# @grounded/api

The Grounded REST API — a small Hono server over the engine, which also serves the web console from
the same origin.

[Grounded](https://github.com/grounded/grounded) is a self-hosted, source-cited memory layer for AI
agents: a shared vision, explicit facts, a session work-log, indexed docs, hybrid recall, and startup
briefs. Apache-2.0, no telemetry.

## Install

```sh
npm install -g @grounded/api    # provides the `grounded-api` bin
```

Most people never install this directly — `grounded install` (from `@grounded/cli`) stands the
service up via Docker or systemd.

## Usage

Run it:

```sh
grounded-api
# grounded-api listening on http://127.0.0.1:7437
# console: http://127.0.0.1:7437/
```

The bin self-bootstraps `~/.grounded` (cabinet, config, migrations) and reads
`GROUNDED_HOME`, `GROUNDED_API_PORT` (7437), `GROUNDED_API_HOST` (127.0.0.1),
`GROUNDED_API_TOKEN`, `GROUNDED_API_UI` (`0` for headless).

Talk to it:

```sh
curl -s localhost:7437/facts -d '{"fact":"Never push without explicit instruction"}'
curl -s localhost:7437/recall -d '{"query":"what did we decide about memory"}'
curl -s localhost:7437/brief  -d '{"agent":"codex","cwd":"'"$PWD"'"}'
```

Embed it:

```js
import { loadConfig, openStore } from "@grounded/core";
import { startServer } from "@grounded/api";

const store = await openStore(loadConfig());
const server = await startServer({ store, port: 7437, token: process.env.GROUNDED_API_TOKEN });
console.log(server.url, server.ui ? "(with console)" : "(headless)");
// await server.close();
```

Or mount the app inside your own server:

```js
import { createApp } from "@grounded/api";
const app = createApp(store, { token: "secret" }); // a Hono app; use app.fetch
```

## Exports

- `startServer(opts)` → `Promise<RunningServer>` — `{ store, token?, port?, host?, ui?,
  typicalFactLimit?, factsReserveTok? }`, returns `{ url, ui, close() }`
- `createApp(store, opts?)` → `Hono` — routes only, no listener
- `serveUi(app, distDir)` / `resolveUiDist()` — attach the built `@grounded/ui` console
- `openApiDocument` — the served OpenAPI document
- types: `StartServerOptions`, `RunningServer`

## Routes

| Method | Path |
|---|---|
| GET | `/health` · `/openapi.json` · `/llms.txt` |
| GET/POST/DELETE | `/vision` · `/vision/:id` |
| GET/POST/PATCH/DELETE | `/facts` · `/facts/:id` |
| GET/POST/DELETE | `/sessions` · `/sessions/:id` |
| GET | `/docs` · `/docs/:id` |
| POST | `/docs/ingest` · `/docs/prune` |
| POST | `/recall` · `/impact` · `/brief` |
| GET | `/get/:typedId` (e.g. `fact:2`, `session:274`, `doc:1091`) |

Auth is a single static bearer token via `GROUNDED_API_TOKEN` / `opts.token`, checked on every route
except `/health`. Off by default for localhost — set it before binding to any other interface.

## Links

- Repo README: <https://github.com/grounded/grounded#readme>
- Typed client: [`@grounded/client`](https://www.npmjs.com/package/@grounded/client)
- License: Apache-2.0
