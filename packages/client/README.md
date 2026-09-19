# @grounded/client

A thin, typed `fetch` wrapper over the Grounded REST API.

[Grounded](https://github.com/flexxdev3/grounded-core) is a self-hosted, source-cited memory layer for AI
agents: a shared vision, explicit facts, a session work-log, indexed docs, hybrid recall, and startup
briefs. Apache-2.0, no telemetry.

Zero runtime dependencies: the types come from `@grounded/core/contract` via `import type`, so
nothing from core loads at runtime.

## Install

Not published to any registry. `@grounded/client` is a workspace library — consume it from a
checkout:

```sh
git clone https://github.com/flexxdev3/grounded-core
cd grounded-core && pnpm install && pnpm build
```

Then depend on it from a package in this workspace (`"@grounded/client": "workspace:*"`), or from an
outside project via a file/link dependency pointing at `packages/client`.

Node >= 20, ESM only. Requires a running `grounded-api`.

## Usage

```js
import { createClient, GroundedHttpError } from "@grounded/client";

const grounded = createClient({
  baseUrl: "http://127.0.0.1:7437",
  token: process.env.GROUNDED_API_TOKEN, // only if the API has auth enabled
});

await grounded.facts.add({ fact: "Never push without explicit instruction", scope: "global" });

const session = await grounded.sessions.add({
  project: "grounded",
  summary: "Wrote the package READMEs.",
});

const { data, meta } = await grounded.recall("what did we decide about pushing?", { limit: 5 });
for (const hit of data) console.log(`[${hit.typedId}] ${hit.title} — ${hit.citation}`);
console.log(`${meta.returned} of ${meta.available}`);

// hard delete a work-log entry — not reversible
await grounded.sessions.delete(session.id); // -> { deleted: true, id }

try {
  await grounded.get("fact:999999");
} catch (err) {
  if (err instanceof GroundedHttpError) console.error(err.status, err.code, err.message);
}
```

`createClient` also accepts `fetch` (e.g. an in-process `app.fetch` from `@grounded/api`, so tests
need no listening port) and `headers` (sent on every request).

## Surface

| Call | Returns |
|---|---|
| `health()` | `HealthReport` |
| `recall(query, opts?)` | `ListResult<RecallResult>` — hybrid search across facts/sessions/docs |
| `impact(subject, opts?)` | `ListResult<ImpactResult>` — "what depends on X?", lexical-only pre-flight |
| `brief(opts?)` | `BriefResult` — scoped startup context |
| `get(typedId)` | `FullRecord` — e.g. `"fact:27"`, `"session:274"`, `"doc:1091"` |
| `vision.set(input)` · `vision.list(opts?)` · `vision.delete(id)` | `Vision` · `ListResult<Vision>` · `{ deleted, id }` |
| `facts.add(input)` · `facts.update(id, patch)` | `FactWriteResponse` (fact + `delivery` rank) |
| `facts.list(opts?)` · `facts.delete(id)` | `ListResult<Fact>` · `{ deleted, id }` |
| `sessions.add(input)` · `sessions.get(id)` | `Session` |
| `sessions.list(opts?)` · `sessions.delete(id)` | `ListResult<Session>` · `{ deleted, id }` |
| `docs.list(opts?)` · `docs.get(id)` | `ListResult<Doc>` · `Doc` |
| `docs.ingest(paths, opts?)` · `docs.prune(opts?)` | `IngestReport` · `{ missing, removed }` |

Exports: `createClient`, `GroundedHttpError`, and the `ClientOptions` / `GroundedClient` types.

Notes worth knowing:

- `meta.available` is the true match count across sources, never derived from `data.length`;
  `meta.truncated` says whether more exist than were returned.
- `recall`/`brief` doc-lane scopes default to `["global"]` when omitted.
- `facts.add` upserts on `topicKey` within a scope — restating a fact edits it in place rather than
  creating a competing row.
- `impact` deliberately crosses lane boundaries: out-of-lane doc hits come back with
  `inScope: false` and a null title/snippet (citation-only).

## Links

- Repo README: <https://github.com/flexxdev3/grounded-core#readme>
- API server: [`@grounded/api`](../api/README.md)
- License: Apache-2.0
