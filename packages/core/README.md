# @grounded/core

The Grounded engine: storage + embedding adapters, hybrid recall, ingest, and config — the library
every other Grounded surface is built on.

[Grounded](https://github.com/flexxdev3/grounded-core) is a self-hosted, source-cited memory layer for AI
agents: a shared vision, explicit facts, a session work-log, indexed docs, hybrid recall
(vector + lexical + RRF), and startup briefs. Apache-2.0, no telemetry, useful without an LLM.

## Install

Not published to any registry. `@grounded/core` is a workspace library — consume it from a checkout:

```sh
git clone https://github.com/flexxdev3/grounded-core
cd grounded-core && pnpm install && pnpm build
```

Then depend on it from a package in this workspace (`"@grounded/core": "workspace:*"`), or from an
outside project via a file/link dependency pointing at `packages/core`.

Node >= 20, ESM only.

## Usage

```js
import { loadConfig, defaultConfig, openStore } from "@grounded/core";

// Resolve config from ~/.grounded/config.toml + GROUNDED_* env, with overrides.
const config = loadConfig({ storage: { adapter: "sqlite", path: "./grounded.db" } });

const store = await openStore(config);

await store.factsAdd({ fact: "Never push without explicit instruction", scope: "global" });
await store.sessionsAdd({ project: "grounded", summary: "Wrote the package READMEs." });

const { data, meta } = await store.recall("what did we decide about pushing?", { limit: 5 });
for (const r of data) {
  console.log(`[${r.typedId}] ${r.title} — ${r.citation}`);
}
console.log(`${meta.returned} of ${meta.available}`);

await store.close();
```

With `embeddings.provider = "none"` this runs fully offline on lexical recall alone.

## Surface

**Entry points**

| Import | Contents |
|---|---|
| `@grounded/core` | everything below, plus the full contract re-export |
| `@grounded/core/contract` | types only — `Store`, `Fact`, `Session`, `Doc`, `RecallResult`, `GroundedConfig`, … |
| `@grounded/core/delivery` | `computeDeliveryRank` — the shared fact-delivery verdict |

**Runtime factories**

- `loadConfig(overrides?)` / `defaultConfig(home?)` / `CONFIG_FILENAME`
- `openStore(config)` → `Promise<Store>`
- `createEmbeddingProvider(config)` → `EmbeddingProvider`
- `computeDeliveryRank(...)` — every write surface must render the same "will this fact be seen?"
  verdict; do not reimplement it.

**Install helpers** (dependency-free, used by the CLI)

- `installSnippet` · `allInstallSnippets` · `INSTALL_TARGETS` · `SERVER_KEY` · `BIN_COMMAND`
- `bootstrap` · `renderConfigToml` · `resolveHome` · `CABINET_DIRS` — materialize `~/.grounded`
- `detect` · `probeHealth` · `detectDocker` · `detectSystemd` · `readManifest` · `writeManifest` ·
  `manifestPath` · `DEFAULT_PORT` · `DOCKER_NAME` · `DOCKER_LABEL` · `SYSTEMD_UNIT`
- `renderSystemdUnit` · `renderDockerRunArgs` · `renderComposeYaml` · `systemdUnitPath`

**Store** covers vision, facts, sessions, and docs CRUD plus `recall`, `impact`, `brief`, `get`,
`ingest`, `prune`, and `health`. Every result carries a citation.

## Adapters

Two plug points live here, both selected by config, never by fork:

- **Storage / index** — `sqlite` (default; `sqlite-vec` + FTS5, one file, zero services) or
  `postgres` (pgvector + tsvector). Both satisfy the same hybrid recall contract.
- **Embeddings** — `ollama` (default, `nomic-embed-text`) · `openai` · `none` (lexical-only).
  Dimensionality is recorded per store; changing models is an explicit re-embed, never silent.

Normative behavior is specified in [`CONTRACT.md`](./CONTRACT.md).

## Links

- Repo README: <https://github.com/flexxdev3/grounded-core#readme>
- License: Apache-2.0
