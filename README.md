# notifications-service

Transactional / campaign email for CureVà, extracted from the main site into a
standalone Cloudflare Worker. Sends templated emails (welcome, opening
announcement, discount codes) to the **waitlist** and tracks
delivery / bounces / complaints via AWS SES + SNS.

Full design doc: [`docs/EMAIL.md`](docs/EMAIL.md).

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Astro `^6.3`, `output: "server"` |
| Runtime | Cloudflare Workers (`@astrojs/cloudflare`) |
| Database | Cloudflare D1 (binding `DB`) — shared with the main CureVà site |
| Email | AWS SES v2 (`@aws-sdk/client-sesv2`) + SNS event webhook |
| Templating | Handlebars |

## Layout

```
src/utils/email/        SES client, Handlebars render, suppression, SNS verify, send loop
src/utils/email-db.ts   email tables + default-template seeding (lazy schema)
src/utils/waitlist-db.ts subscriber schema (unsubscribe_token, email_status)
src/pages/index.astro             dashboard at / — compose / preview / templates / logs (auth-gated)
src/pages/api/email/send.ts       POST /api/email/send       — campaign send (auth-gated)
src/pages/api/email/templates.ts  POST /api/email/templates  — template CRUD (auth-gated)
src/pages/api/email/test.ts       POST /api/email/test       — single test send (auth-gated)
src/pages/api/webhooks/ses.ts     POST /api/webhooks/ses     — SNS receiver (public)
src/pages/unsubscribe/[token].astro  public opt-out page
src/middleware.ts                 auth gate (protects / and /api/email/*)
src/utils/admin-auth.ts           HMAC session token helpers
src/pages/login.astro             sign-in form  (/login)
src/pages/logout.ts               clears the session cookie  (/logout)
```

## Commands

```bash
pnpm install
pnpm dev         # astro dev
pnpm build       # astro build (compiles the Worker)
pnpm typecheck   # astro check
pnpm test:e2e    # build + preview the Worker, run the Playwright E2E suite
pnpm deploy      # build && wrangler deploy
pnpm ship        # typecheck && test:e2e && deploy  (gated local deploy)
```

## Testing & CI

End-to-end tests (Playwright, against the built Worker under Miniflare) cover
the auth gate, template CRUD, the send-path **safety invariant** (no test can
trigger a real AWS SES send), the SNS webhook, and the public unsubscribe page.
CI (`.github/workflows/ci.yml`) runs them on every push/PR and **deploys to
Cloudflare only after they pass** (pushes to `main`). Full guide:
[`docs/TESTING.md`](docs/TESTING.md).

> **Note — CSRF is intentionally disabled** (`astro.config.mjs`,
> `security.checkOrigin: false`). AWS SNS posts to `/api/webhooks/ses` as
> `text/plain` with no `Origin` header, which Astro's default CSRF check would
> reject with a 403 before the handler runs — silently dropping every SES
> delivery/bounce/complaint event. Protection now comes from the signed-cookie
> auth gate, the SNS signature verification, and the unsubscribe token — all
> stronger than origin reflection for a Worker that serves APIs and webhooks.

## Configuration

D1 binding `DB` is set in [`wrangler.jsonc`](wrangler.jsonc) — point it at the
same database the CureVà site uses (the `waitlist` table is the subscriber
list).

SES credentials are **secrets**, not vars:

```bash
wrangler secret put AWS_REGION
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put PUBLIC_SITE_URL   # optional, for unsubscribe links
```

Local dev: copy `.dev.vars.example` → `.dev.vars` and fill in.

## Admin auth

The dashboard at `/` and the `/api/email/*` action endpoints are gated by
`src/middleware.ts`: a signed-cookie session (HMAC-SHA256, 12 h TTL) keyed by
the `ADMIN_PASSWORD` secret. Public routes: `/login`, `/logout`, the public
`/unsubscribe/*` page, and the `/api/webhooks/*` SNS receiver.

```bash
wrangler secret put ADMIN_PASSWORD     # required — if unset, / returns 404
wrangler secret put ADMIN_USERNAME     # optional — defaults to "admin"
```

Local dev: add `ADMIN_PASSWORD` (and optional `ADMIN_USERNAME`) to `.dev.vars`.

## Follow-ups after extraction

- The public `POST /api/waitlist` rate-limiter (`src/utils/rate-limit.ts`) lives
  in the main site; this service does not host the signup endpoint.
