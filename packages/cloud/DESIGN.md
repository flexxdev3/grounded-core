# Grounded Cloud — hosted-cabinet design

The commercial layer: **managed Grounded cabinets** — a user signs up, gets an isolated cabinet
(their own facts / sessions / docs / vision), and points their agents (MCP / HTTP) and browser
(console) at a hosted endpoint instead of running the service themselves. Starts on the OVH box,
migratable by design.

> **Governing rule — the open-core boundary.** Self-hosted Grounded stays no-account, single-cabinet
> (North-star #1: "no account required"). Every account/multi-tenant concern lives in this package,
> `@grounded/cloud`, which is **`private: true`** — it is never in `pnpm publish -r`. The open engine
> (`@grounded/core`) never learns what a "user" is. Cloud *consumes* core; core has no idea cloud exists.

---

## 1. Architecture

```
 user's agent  ──(bearer: grnd_… API token)──┐
 browser       ──(session cookie)────────────┤
                                              ▼
                                   ┌────────────────────────┐
                                   │  @grounded/cloud gateway │  (Hono, one process on OVH)
                                   │                          │
                                   │  /auth/*   → better-auth │  ── accounts schema (control plane)
                                   │  /account/* → account API│
                                   │  /api/*    → tenant proxy │
                                   │      authenticate         │
                                   │      → resolve tenant     │
                                   │      → get cached Store    │
                                   │      → createApp(store)    │  ◄── @grounded/api (UNCHANGED)
                                   │           └► @grounded/core │  ◄── engine (UNCHANGED)
                                   └────────────┬─────────────┘
                                                ▼
                          ┌─────────────────── Postgres ───────────────────┐
                          │  schema "accounts"     ← control plane          │
                          │  schema "grounded_ab12" ← tenant A cabinet       │
                          │  schema "grounded_cd34" ← tenant B cabinet       │
                          │  … one schema per user, real isolation           │
                          └──────────────────────────────────────────────────┘
     OVH deploy = docker compose: cloud-gateway + postgres + ollama (+ cloud-ui static)
```

**Why this shape.** Each tenant is a Grounded cabinet = `openStore({adapter:"postgres", schema:"grounded_<id>"})`.
The Postgres migration already runs `create schema if not exists` and self-migrates, so **provisioning a
cabinet is one `openStore` call**. The existing `@grounded/api` `createApp(store)` is reused verbatim per
tenant. Cloud adds only: auth, a control-plane schema, tenant→schema resolution, and a bounded Store cache.

---

## 2. Tenant isolation — schema-per-tenant

- **Tenant = Postgres schema** `grounded_<cabinetId>` (cabinetId = short opaque id, not the numeric user id).
- **Provision:** `openStore({storage:{adapter:"postgres", url:CLOUD_PG_URL, schema}})` → creates + migrates
  the schema. Idempotent. Recorded in `accounts.cabinets`.
- **Isolation:** every query is `"schema".table` (adapter already does this); no shared rows, no `tenant_id`
  column, no cross-tenant leak surface. A bug in recall can't read another tenant.
- **Export (honors the recoverable-cabinet promise):** `pg_dump -n grounded_<id>` = one file, the whole
  cabinet, restorable anywhere — including into a self-hosted install. Offered from Settings → Export.
- **Delete:** `drop schema grounded_<id> cascade` + remove the `cabinets` row.
- **Scale path:** schemas are cheap on one Postgres into the thousands. Beyond OVH: shard tenants across
  Postgres instances keyed by `cabinets.shard`; migrate a tenant by dump/restore of its single schema. No
  data-model change — that's the whole point of schema isolation.

### Store cache
Opening a pg pool per request is fatal. The gateway keeps a bounded **LRU of live Stores** keyed by schema
(`tenants.ts`): get-or-open, cap ~200 hot tenants, evict-and-`close()` the least-recently-used. Each entry
also memoizes its `createApp(store)` Hono instance so `/api/*` delegation is a plain `app.fetch(subReq)`.

---

## 3. Control plane — `accounts` schema

Cloud owns its own schema, separate from every tenant cabinet. better-auth manages the first three tables
(its Postgres adapter creates `user` / `session` / `account` / `verification`); we add the rest.

| Table | Purpose | Key columns |
|---|---|---|
| `user` | account | id, email, emailVerified, name, image, createdAt (better-auth) |
| `session` | browser sessions | id, userId, token, expiresAt, ip, userAgent (better-auth) |
| `account` | password hash + OAuth links | userId, providerId, accountId, password (better-auth) |
| `verification` | email-verify / reset tokens | (better-auth) |
| `cabinets` | user → cabinet schema | id, userId, schema, plan, status, shard, createdAt |
| `api_tokens` | agent/MCP bearer tokens | id, cabinetId, name, tokenHash, prefix, scopes, lastUsedAt, createdAt, revokedAt |
| `usage` | metering snapshot | cabinetId, facts, sessions, docChunks, bytes, capturedAt |

- **One cabinet per user in v1** (`cabinets` UNIQUE on userId); the model already allows N for teams later.
- **API tokens** are shown once at creation (`grnd_<prefix>_<secret>`); we store `sha256(secret)` +
  a short `prefix` for display/lookup. Verify = hash the presented secret, match, check `revokedAt IS NULL`,
  touch `lastUsedAt`. Scopes reserved (`read`/`write`) — v1 issues full-access.

---

## 4. Auth — better-auth (self-hosted)

`better-auth` (@1.6.x), Postgres adapter on the `accounts` schema. Enabled:
- **email + password** (argon2 via better-auth), email verification + password reset.
- **GitHub OAuth** (audience is developers) — `GITHUB_CLIENT_ID/SECRET`.
- **session cookies** for the browser console; httpOnly, secure, sameSite=lax.

Mounted at `/auth/*` (better-auth's Hono handler). The account API and console read the session via
better-auth's `getSession`. Agents do **not** use sessions — they use API tokens (§3), verified by our own
middleware, independent of better-auth.

Trade-off stated: better-auth is one dependency, but auth primitives (session fixation, reset-token entropy,
OAuth state) are exactly where hand-rolled code leaks. Vetted lib = less security-critical code we own.

---

## 5. Gateway routes (`@grounded/cloud`)

| Prefix | Auth | Handler |
|---|---|---|
| `/auth/*` | — | better-auth (signup/login/oauth/reset/verify) |
| `/account/me` | session | current user + cabinet summary |
| `/account/cabinet` | session | cabinet status, endpoint URL, usage counts |
| `/account/tokens` (GET/POST/DELETE) | session | list / create (secret shown once) / revoke API tokens |
| `/account/connect` | session | copy-paste MCP + hook config pointed at *their* URL+token (reuses `installSnippet`) |
| `/account/export` | session | trigger `pg_dump -n` of the tenant schema → download |
| `/account` (DELETE) | session | delete account: export-guard → drop schema → remove rows |
| `/api/*` | **API token OR session** | resolve cabinet → cached Store → `createApp(store).fetch()` — the full existing API |
| `/` (+ console assets) | session-gated shell | cloud UI (account pages + embedded console) |

`/api/*` is the same 18 routes the self-hosted API exposes — a hosted user's agents talk to Grounded
identically to a self-hoster, only the base URL + token differ. That keeps MCP/hook/client config a
one-line change between self-hosted and hosted.

---

## 6. Account UI (the pages, "with UI and all")

> **Status: BUILT (2026-07-13).** All 8 surfaces implemented in `@grounded/cloud-web` (`web/`), render-
> verified at 375 + 1440. Implementation spec → [`web/TECH-SPECS.md`](web/TECH-SPECS.md). Two open items:
> the Cabinet tab needs `@grounded/ui` pointed at `/api` (config-driven base), and `bytes` isn't in the
> health payload. See §9 of the tech-specs.

Preact + Vite (mirrors `@grounded/ui`), same `tokens.css` design language. Session-gated shell; the
existing console mounts as one tab, tenant-scoped.

1. **Sign up / Log in** — email+password + "Continue with GitHub". Split layout, the brief-as-hero motif
   from the marketing site on the left, form on the right.
2. **Onboarding** (first login) — provisions the cabinet, reveals **endpoint URL + first API token**
   (shown once), and the copy-paste connect snippet. The "you're live" moment.
3. **Dashboard** — cabinet status card (endpoint, plan, region=OVH), usage (facts/sessions/docs/bytes),
   quick links. Reuses the console's health/counts.
4. **Connect your agent** — tabbed MCP (Claude Code / Codex / Cursor / generic) + SessionStart hook
   config, prefilled with their URL + a token. The killer onboarding surface; reuses `installSnippet`.
5. **API tokens** — table (name, prefix, last used, created), create (modal, secret shown once, copy),
   revoke (confirm). 
6. **Cabinet** — the existing `@grounded/ui` console, tenant-scoped (Recall · Facts · Sessions · Docs ·
   Vision · Brief · Health).
7. **Settings** — profile (name/email), password change, **export cabinet**, danger zone (delete account,
   export-first guard).
8. **Billing** — *stub*: current plan (Free), plan comparison, "Upgrade" CTA wired to a placeholder. Real
   Stripe = follow-up phase.

Design pass will run through the StuntLabs design workflow (taste only — `corpus/stuntlabs-design/PRINCIPLES.md`,
no external design skills) per the global design-startup rule before building the visual surface.

---

## 7. Deploy (OVH now, migratable)

`docker-compose.cloud.yml`: `cloud-gateway` (this package) + `postgres` (pgvector) + `ollama` +
static `cloud-ui`. Env: `CLOUD_PG_URL`, `CLOUD_BASE_URL`, `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID/SECRET`,
`GROUNDED_EMBED_BASEURL`. TLS via the OVH reverse proxy (Caddy/nginx). Migration off OVH = point
`CLOUD_PG_URL` at the new Postgres and dump/restore schemas; nothing else changes.

---

## 8. Build order

1. Package scaffold + config + control-plane migration (`accounts` schema).
2. Tenant manager (Store LRU + provisioning) + API-token issue/verify.
3. better-auth wiring + account API routes.
4. `/api/*` tenant proxy → `createApp`.
5. Account UI (design pass first, then build the 8 surfaces). ✓ built 2026-07-13 → `@grounded/cloud-web`.
6. `docker-compose.cloud.yml` + OVH deploy notes.
7. Tests: tenant isolation (two schemas don't see each other), token verify, provision/delete round-trip.

**Non-goals v1:** real payments, teams/multi-user cabinets, per-token scopes enforcement, usage-based
limits. All are reserved in the data model, none built.
