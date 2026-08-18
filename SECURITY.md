# Security Policy

## Reporting a vulnerability

Report privately. Do **not** open a public issue, pull request, or discussion for a suspected
vulnerability.

- Email: `security@` <!-- TODO(maintainer): contact address -->
- Or use GitHub's private "Report a vulnerability" flow on the repository's Security tab.

Please include: affected version and package, environment (storage adapter, embedding provider,
install method), reproduction steps or a proof of concept, and the impact you believe it has.

What to expect:

- Acknowledgement within 5 business days.
- An assessment and a fix plan, or an explanation of why it is not a vulnerability, within 30 days.
- Credit in the release notes if you want it.

Please give us a reasonable window to ship a fix before public disclosure.

## Supported versions

Grounded is pre-1.0. Only the latest published `0.x` minor of each `@grounded/*` package receives
security fixes; older minors are not backported. All packages are versioned and released together.

| Version | Supported |
|---|---|
| latest `0.x` | yes |
| any earlier `0.x` | no |

## Scope

In scope: the packages published from this repository (`@grounded/core`, `@grounded/api`,
`@grounded/mcp`, `@grounded/client`, `@grounded/ui`, `@grounded/cli`), the container image built from
this repo's `Dockerfile`, and the systemd/Docker units the installer writes.

Out of scope: vulnerabilities in third-party services you configure Grounded to talk to (Postgres,
Ollama, OpenAI), and findings that require an attacker to already have write access to
`~/.grounded` or the host account running the service.

## Deployment notes that affect your threat model

- Grounded binds to `127.0.0.1` by default and auth is off for localhost. If you expose the API on
  another interface, set `GROUNDED_API_TOKEN` and put TLS in front of it.
- The store holds whatever you put in it — facts, session notes, and ingested documents are stored in
  plaintext in SQLite or Postgres so they stay human-readable and recoverable. Treat the cabinet
  directory (`~/.grounded`) as sensitive.
- `.groundignore` and `<private>` stripping apply at ingest; verify them before ingesting a directory
  containing secrets.

## No telemetry

Grounded collects no telemetry, sends no analytics, and requires no account. The only network calls
it makes are the ones you configure: your storage backend and your embedding provider (and none at
all with `embeddings = "none"`). Nothing is reported back to the maintainers, ever.
