# @grounded/cloud-web — technical specs

Implementation reference for the **hosted-cabinet account UI** — the signed-in SPA a user
sees after signing up for managed Grounded. Documents **what the code does**: package layout,
surface→route→data map, the wire contract it calls, the fixture mode, the design system, and how
the gateway serves it.

**Boundaries:**
- Mechanism (backend architecture — gateway, tenant isolation, control plane) → [`../DESIGN.md`](../DESIGN.md).
- The brief this was built from → [`../UI-BRIEF.md`](../UI-BRIEF.md).
- Visual language → the StuntLabs one-sheet `corpus/stuntlabs-design/PRINCIPLES.md` + Grounded
  `grounded/DESIGN.md` ("Cinematic Terminal"). No external design skills.

> Built 2026-07-13 as an unplanned follow-on to the cloud backend (alicia). Session write-up →
> `corpus/grounded/session-2026-07-13-cloud-account-ui.md`.

---

## 1. Package layout & stack

New **7th** workspace package (`@grounded/core` now feeds core/cli/api/mcp/client/**ui**/**cloud**),
private (never published), nested under the private `@grounded/cloud`:

```
packages/cloud/web/
  index.html            # font preload (EB Garamond / Inter / JetBrains Mono), #app mount
  vite.config.ts        # base:"./", preact; dev proxies /auth /account /api → gateway :8088
  src/
    main.tsx            # render(<App/>)
    app.tsx             # session gate + hash router + signed-in Shell
    styles/
      tokens.css        # design tokens (self-contained; derived from console + site)
      app.css           # the Cinematic-Terminal skin (imports tokens.css)
    lib/
      types.ts          # wire shapes mirrored from the backend (no build coupling)
      api.ts            # account/* + better-auth /auth/* fetch wrappers; MOCK branch
      fixtures.ts       # in-memory backend for the design/verify loop (?mock)
      brief.ts          # the brief-as-hero content (the signature panel's data)
    components/
      icons.tsx         # line icons + brand mark (no emoji)
      ui.tsx            # CopyButton, Term, BriefPanel, Modal, ToastHost/toast()
    surfaces/           # the 8 surfaces (one file each)
      Auth · Onboarding · Dashboard · Connect · Tokens · Cabinet · Settings · Billing
```

- **Stack:** Preact + Vite, TypeScript ESM. Deps: `preact`, `@grounded/client` (typed API wrapper),
  `@grounded/ui` (the console, for the Cabinet surface). **No** router lib, state lib, or UI kit —
  hash routing + `preact/hooks` only.
- **Bundle (production):** ~51 kB JS / ~20 kB CSS (≈17 kB / ≈4.7 kB gzip). Zero-dep runtime.
- **Served** by the `@grounded/cloud` gateway as static assets at `/` (see §7). Same-origin ⇒ the
  session cookie and `/account` · `/api` calls need no CORS.

## 2. Surfaces

Eight surfaces. Surfaces 1–2 render outside the shell (full-screen); 3–8 render inside the
signed-in Shell (sidebar + topbar). "Data" is the live call each makes (mocked under `?mock`).

| # | Surface | Route / when | Data source | Notes |
|---|---------|--------------|-------------|-------|
| 1 | **Auth** | no session | `auth.signIn/signUp`, `auth.github()` | Split layout; left = brief-as-hero (`=== STARTUP CONTEXT ===`), right = form + GitHub |
| 2 | **Onboarding** | session, no cabinet | `GET /account/cabinet` (provisions) → `POST /account/tokens` | Endpoint + first token **shown once** + hook snippet. The "you're live" moment |
| 3 | **Dashboard** | `#/dashboard` | `GET /account/cabinet` | Stat numerals (facts/sessions/documents/dims), endpoint card, brief echo |
| 4 | **Connect** | `#/connect` | `GET /account/connect` | hook / curl / client tabs; endpoint + copy |
| 5 | **API tokens** | `#/tokens` | `GET/POST/DELETE /account/tokens` | Table; create-modal (secret once → copy); revoke confirm |
| 6 | **Cabinet** | `#/cabinet` | `@grounded/ui` console @ `/api` | Mount point — see §9①; graceful placeholder under `?mock` |
| 7 | **Settings** | `#/settings` | profile/password (stub), `DELETE /account` | Export (soon), danger zone with type-`DELETE` guard |
| 8 | **Billing** | `#/billing` | — | Stub: Free/Pro/Team, Upgrade → placeholder (no Stripe) |

## 3. Routing & session gate (`app.tsx`)

- **Gate (on mount):** `auth.session()` → `null` renders **Auth**; a user with `cabinet: null` renders
  **Onboarding**; otherwise the **Shell**. `refresh()` re-runs the gate after auth/provision so the
  surface advances without a full reload.
- **Router:** hash-based (`#/dashboard` …). `routeFromHash()` clamps unknown hashes to `dashboard`;
  a `hashchange` listener drives `<Shell>`. No history API, no route lib — deep links are hash links.
- **Shell:** sidebar nav (Cabinet group: Dashboard · Connect · Cabinet; Account group: API tokens ·
  Settings · Billing) + sticky topbar (`>_ grounded / <surface>` crumb, sign-out). Sidebar collapses
  to an off-canvas drawer + hamburger under 860px.
- **Session context** (`useSession()`) exposes `{ me, refresh, signOut }` to shell surfaces.

## 4. API + auth client (`lib/api.ts`)

All requests are same-origin with `credentials: "include"` (session cookie). `ApiError{status,code}`
carries backend `{error,code}`; `errMessage()` normalizes anything thrown for display.

**Auth** — better-auth at `/auth/*`:

| Fn | Call |
|---|---|
| `auth.session()` | `GET /auth/get-session` → if user, hydrate `GET /account/me`; 401/none ⇒ `null` |
| `auth.signUp(email,pw,name)` | `POST /auth/sign-up/email` |
| `auth.signIn(email,pw)` | `POST /auth/sign-in/email` |
| `auth.github()` | redirect `GET /auth/sign-in/social?provider=github&callbackURL=<here>` |
| `auth.signOut()` | `POST /auth/sign-out` |

**Account** — `/account/*`, session-gated:

| Fn | Call | Returns |
|---|---|---|
| `account.me()` | `GET /account/me` | `{ user, cabinet\|null }` |
| `account.cabinet()` | `GET /account/cabinet` | `{ cabinet, endpoint, health }` (provisions on first call) |
| `account.connect()` | `GET /account/connect` | `{ endpoint, snippets }` (placeholder token) |
| `account.tokens.list()` | `GET /account/tokens` | `ApiToken[]` |
| `account.tokens.create(name)` | `POST /account/tokens` | `{ token, secret, connect }` — **secret once** |
| `account.tokens.revoke(id)` | `DELETE /account/tokens/:id` | — |
| `account.deleteAccount()` | `DELETE /account` | — |

`types.ts` mirrors these shapes locally (User, Cabinet, `HealthReport{counts:{facts,sessions,docs,documents}}`,
ApiToken, ConnectSnippets, IssuedToken, Me) so the UI has no build-time dependency on the private
cloud package internals — only the wire contract.

## 5. Fixture / mock mode (`lib/fixtures.ts`)

Enabled by `VITE_MOCK=1` or a `?mock` query flag. Every `api.ts` function branches to an in-memory
fixture, so all 8 surfaces render + verify with **no** Postgres / better-auth / ollama. Scenarios via
the flag value:

- `?mock` — signed in, cabinet provisioned (Dashboard/Connect/Tokens/Settings/Billing)
- `?mock=fresh` — signed in, **no** cabinet (drives Onboarding)
- `?mock=out` — signed out (drives Auth)

Fixtures hold a realistic cabinet, two seed tokens, and mutate on create/revoke (secret generated
client-side, shown once) so the flows are exercisable end to end in the design loop.

## 6. Design system (`styles/`)

**"Cinematic Terminal", dark operator register.** The app *is* the console, so it stays on the dark
`night` field (paper reserved for rare "document" moments). Passes the StuntLabs acceptance gate on
every surface at 375 and 1440.

- **`tokens.css`** — self-contained (derived from `@grounded/ui` tokens + `grounded/DESIGN.md`; **not**
  cross-imported, per the separate-build rule). Palette (night surfaces, paper text, **one** verdigris
  accent + copper punctuation, semantic danger/warn), glow/phosphor/scanline, fluid type scale
  (`--fs-display…--fs-mono`), radius, spacing.
- **`app.css`** — the skin. Type primitives (`.display/.h1-3/.lede/.eyebrow/.mono/.prompt`), buttons
  (pill primary verdigris→copper, ghost, danger, text-link), cards, forms, tables, tabs, modal, toast,
  the terminal/code block (`.term`), the **brief panel** (`.brief` — the signature), the auth split,
  the shell, the stat module.
- **Motion rule (enforced):** hover/focus/active expressed as **glow / shadow / border / brightness
  only** — no `translate` lift anywhere. CRT scanline laid over glow on dark screens via `.scanned`.
- **Global button reset** (`button{border:0;background:none;color:inherit;padding:0}`) so no bare
  button leaks user-agent chrome; each button class sets its own surface.
- **The signature:** `BriefPanel` renders a real `=== STARTUP CONTEXT ===` brief (data in `lib/brief.ts`,
  MESSAGING voice) — the auth hero, the onboarding proof, and the dashboard echo. Carries the product's
  whole pitch (a cold agent that wakes up oriented) into the account UI.

## 7. Gateway static serve (`../src/static.ts`)

The account UI is served by the gateway (added this session — the "20-line addition" the brief offered):

- `resolveCloudUiDist()` — `CLOUD_UI_DIST` env, else `<cloud-pkg>/web/dist` relative to the compiled
  module; `null` if no build present (gateway then runs headless / API-only).
- `serveCloudUi(app, dist)` — `index.html` at `/` + `/index.html`, `/assets/*` (immutable cache),
  `/favicon.ico`, and a `*` **SPA fallback** to `index.html`. Registered **last** in `createGateway()`
  so `/auth`, `/account`, `/api`, `/healthz` always win; the fallback explicitly 404s those prefixes.
- The bundle is public (the app renders its own auth gate; data stays gated by `/account` + `/api`).

## 8. Build & verification

- **Build:** `pnpm -C packages/cloud/web build` (vite → `dist/`). `pnpm -C packages/cloud/web typecheck`.
- **Dev:** `pnpm -C packages/cloud/web dev` (:8089) — proxies `/auth /account /api` to a local gateway
  (`CLOUD_GATEWAY_URL`, default `:8088`). For a backend-free design pass, open `…/?mock`.
- **Verified this session:** all 8 surfaces rendered at 1440 and 375, **zero console errors**, fonts
  confirmed loaded via `document.fonts` (EB Garamond / Inter / JetBrains Mono — not fallback), mobile
  drawer + create-token/revoke/delete modals exercised. `@grounded/cloud` typecheck green with the
  new static handler.

## 9. Open integration items

1. **Cabinet console base path.** `@grounded/ui` hardcodes `createClient({ baseUrl: "" })` (same-origin
   root). Served inside Cloud it would call `/facts` (404 — the gateway exposes only `/api/*`). Mounting
   the console tenant-scoped needs a **config-driven base** in `@grounded/ui` (e.g. `window.__GROUNDED_BASE__`
   / `<meta>` / `VITE_GROUNDED_BASE`) resolving to `/api`. ~1-line change + rebuild. Until then the
   Cabinet surface renders a placeholder (real mode iframes `./console/`).
2. **`bytes` usage metric.** UI-BRIEF §3 lists `bytes` on the dashboard, but `HealthReport.counts` is
   `{facts,sessions,docs,documents}` only — no `bytes`. Dashboard renders facts/sessions/documents +
   embed dims + storage location instead. Add `bytes` to the health/usage payload to surface it.
3. **Auth polish deferred:** email-verify / password-reset flows (better-auth supports them; UI not yet
   wired), and the Settings profile/password forms are optimistic stubs (toast only) pending endpoints.
