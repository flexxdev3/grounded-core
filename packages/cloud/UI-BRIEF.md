# Grounded Cloud — account UI build brief (for the designer agent)

**Task:** design + build the hosted-cabinet **account UI** — the 8 surfaces a user sees after they sign
up for managed Grounded. The backend is built and compiling on the `accounts` branch of
`grounded-core`; this brief is the front-end half.

**Read first (design-startup rule — StuntLabs taste only):**
1. `/home/flexx/work/0-tools/homelab-context/corpus/stuntlabs-design/PRINCIPLES.md` — THE one-sheet
   (thesis · principles · anti-slop blocklist · acceptance gate · operating loop). Operate from this.
   Do NOT load external design skills (Hermes `claude-design`, `frontend-design`, `design-md`) — their
   doctrine is already folded into PRINCIPLES.md. `PLAYBOOK.md` (same dir) only for a specific technique.
2. `grounded/MESSAGING.md` — voice SoT ("premium with dry wit"; tagline *Your agents forget. Grounded doesn't.*)
3. `grounded/DESIGN.md` — the site's **Cinematic Terminal** design language
4. `grounded-core/packages/cloud/DESIGN.md` — the hosted-cabinet mechanism (what the UI sits on top of)
5. `grounded-core/packages/ui/` — the **existing console** (Preact+Vite, `src/styles/tokens.css`) — reuse
   its design language and mount it as the "Cabinet" surface (#6 below).

---

## Stack / where it lives
- New UI under `grounded-core/packages/cloud/web/` (Preact + Vite, mirror `@grounded/ui`'s setup).
  Zero-dep runtime, small bundle, same `tokens.css` design language (copy/derive, don't cross-import).
- Session-gated SPA shell. Served by the gateway (`bin.ts`) as static assets at `/` (add a static handler
  like `@grounded/api`'s `src/static.ts` — ask if you want it wired, it's a 20-line addition to the gateway).
- **Design language = the marketing site + console**, NOT a generic SaaS dashboard. Calm, premium,
  technical, trustworthy. Explicitly NOT cyberpunk/neon AI-slop. Beautiful typography: big contrasting
  headings, quiet metadata. Match sibling elements on every axis (house rule).

## The API the UI calls (all live, on the gateway)
- **Auth** (better-auth, `/auth/*`): use better-auth's client or plain fetch — signup, login, GitHub OAuth,
  logout, password reset. Session is an httpOnly cookie (send `credentials: "include"`).
- **Account** (`/account/*`, session-gated):
  - `GET /account/me` → `{ user:{id,email}, cabinet|null }`
  - `GET /account/cabinet` → `{ cabinet:{id,plan,status,shard}, endpoint, health }` (provisions on first call)
  - `GET /account/tokens` → `{ tokens:[{id,name,prefix,scopes,lastUsedAt,createdAt,revokedAt}] }`
  - `POST /account/tokens {name}` → `{ token, secret, connect:{hook,curl,client} }` — **secret shown ONCE**
  - `DELETE /account/tokens/:id`
  - `GET /account/connect` → `{ endpoint, snippets:{hook,curl,client} }` (placeholder token)
  - `DELETE /account` → delete account + cabinet
- **Cabinet data** (`/api/*`, same token/session): the full existing Grounded API — `/recall`, `/facts`,
  `/sessions`, `/docs`, `/vision`, `/brief`, `/health`, `/get/:id`. The console already speaks this; point
  `@grounded/client` at `/api`.

## The 8 surfaces
1. **Sign up / Log in** — email+password + "Continue with GitHub". Split layout; left = the brief-as-hero
   motif (a real `=== STARTUP CONTEXT ===` block, per MESSAGING §4), right = the form. The first impression.
2. **Onboarding** (first login, no cabinet yet) — provision the cabinet, reveal **endpoint URL + first API
   token** (from `POST /account/tokens`, shown once — copy button, "save this now" warning) + the connect
   snippet. The "you're live" moment.
3. **Dashboard** — cabinet status card (endpoint, plan, region=OVH), usage counts (facts/sessions/docs/bytes
   from `/account/cabinet` health), quick links to Connect + Cabinet.
4. **Connect your agent** — tabbed snippets (`hook` / `curl` / `client`) from the connect payload, prefilled
   with their URL + token. Copy buttons. This is the killer onboarding surface — make it effortless.
5. **API tokens** — table (name, prefix, last used, created), create (modal → secret shown once → copy),
   revoke (confirm dialog).
6. **Cabinet** — the existing `@grounded/ui` console, tenant-scoped (Recall · Facts · Sessions · Docs ·
   Vision · Brief · Health). Reuse it wholesale pointed at `/api`; don't rebuild it.
7. **Settings** — profile (name/email), password change, **export cabinet** (button; backend export is a
   follow-up — wire the button + "coming soon" if the endpoint isn't ready), danger zone (delete account,
   with an "export first" nudge).
8. **Billing** — **stub**: current plan (Free), plan comparison cards, "Upgrade" CTA → placeholder. No Stripe
   this phase (reserved).

## Constraints / non-goals
- Billing is a stub; no real payments. Export/delete UI present, export backend may lag.
- One cabinet per user (v1). No teams UI.
- Every result the Cabinet console shows is already cited — preserve that (it's the product's trust pitch).

## Deliverable + verification
- All 8 surfaces built, session-gated, wired to the live gateway API.
- Design pass verified: no horizontal overflow @1440/390, zero console errors, sibling-parity on shared
  components, typography does real work (per DESIGN.md).
- Gate: `pnpm --filter @grounded/cloud build` (or the web sub-build) green.
- Log a `/ground-session` when done and refresh grounded STATE.md.

**Branch:** `accounts` (in `grounded-core`). **Backend files to read for exact shapes:**
`packages/cloud/src/{account,tokens,tenants,config}.ts`. Ping back on the desk if the gateway static-serve
wiring or the export endpoint needs to land before you can finish.
