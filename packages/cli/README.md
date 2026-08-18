# @grounded/cli

The `grounded` command — stands up and manages the Grounded service (Docker or systemd) and wires it
into your agents.

[Grounded](https://github.com/grounded/grounded) is a self-hosted, source-cited memory layer for AI
agents: a shared vision, explicit facts, a session work-log, indexed docs, hybrid recall, and startup
briefs. Apache-2.0, no telemetry.

> This is an **installer/manager only**. There is no data CLI: humans use the web console, agents use
> MCP, scripts use the HTTP API.

## Install

```sh
npx @grounded/cli install
# or
npm install -g @grounded/cli    # then the on-PATH command is `grounded`
```

Node >= 20.

## Usage

```sh
grounded install                    # detect host capabilities → pick Docker or systemd → cabinet + service
grounded status                     # is it running, how, and healthy?
grounded mcp install claude-code    # print a ready-to-paste MCP server config
grounded hooks print claude-code    # print a SessionStart brief hook + wiring
```

`install` creates `~/.grounded` (config + database + migrations), starts the service on
`http://127.0.0.1:7437`, and refuses to double-install if an instance is already detected. Then open
`http://127.0.0.1:7437/` for the console.

## Commands

| Command | What |
|---|---|
| `install` | stand Grounded up as a persistent service (Docker or systemd) |
| `status` | show whether Grounded is running, how, and its health |
| `start` · `stop` · `restart` | service lifecycle |
| `logs` | show service logs |
| `uninstall` | remove the service (keeps the cabinet/data by default) |
| `init` | create the cabinet (`~/.grounded`), write default config, run migrations |
| `mcp install [target]` · `mcp targets` | print a ready-to-paste MCP server config (does not modify files) |
| `hooks print [target]` · `hooks targets` | print a SessionStart hook script + wiring (does not modify files) |

Global options: `--home <path>` (overrides `GROUNDED_HOME`), `--json` (machine-readable output).

Notable per-command options:

- `install`: `--port <n>` · `--method docker|systemd-user|systemd-system` · `--image <ref>` ·
  `--token <tok>` · `-y, --yes` · `--force`
- `status`: `--port <n>` · `logs`: `-f, --follow`
- `uninstall`: `--purge` (also deletes `~/.grounded` — destroys all data) · `-y, --yes`
- `mcp install`: `--env KEY=VAL` (repeatable) · `--all`

## Install methods

| Method | What it does | When |
|---|---|---|
| Docker | builds or pulls the image and runs a labelled `restart=unless-stopped` container mounting `~/.grounded` | Docker daemon reachable — the default |
| systemd (user) | installs `@grounded/api`, writes `~/.config/systemd/user/grounded.service`, `enable --now` | no root; runs as you |
| systemd (system) | the same, at `/etc/systemd/system` via sudo | always-on; needs root/sudo |

Env knobs, no config edit needed: `GROUNDED_HOME`, `GROUNDED_API_PORT`, `GROUNDED_API_TOKEN`,
`GROUNDED_EMBED_PROVIDER`, `GROUNDED_EMBED_BASEURL`, `GROUNDED_EMBED_MODEL`, `GROUNDED_IMAGE`.

## Links

- Repo README: <https://github.com/grounded/grounded#readme>
- License: Apache-2.0
