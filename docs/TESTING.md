# Testing & deploy pipeline

End-to-end tests for the notifications-service, plus the CI pipeline that
**deploys only after the tests pass**.

Tests use [Playwright](https://playwright.dev) against the **built Cloudflare
Worker** (via `astro preview` / Miniflare), so they exercise the real endpoints
with live local D1 + KV bindings — not the dev server.

---

## 1. Running locally

```bash
pnpm test:e2e            # build the Worker, preview it, run every spec
pnpm test:e2e:ui        # the same, in Playwright's interactive UI
npx playwright test e2e/templates.spec.ts        # one file
npx playwright test -g "auth gate"                # one describe/test
```

First run only: `npx playwright install chromium`.

The dashboard and `/api/email/*` are auth-gated, so the suite needs
`ADMIN_PASSWORD` set. Locally it comes from `.dev.vars` (already present with
`ADMIN_PASSWORD=devpassword`). Specs that need it **skip** cleanly when it is
absent rather than failing.

### One-command gated deploy (local)

```bash
pnpm ship               # typecheck → test:e2e → deploy (aborts if any step fails)
```

This mirrors CI: nothing deploys unless the E2E suite is green.

---

## 2. The all-important safety invariant

**No test may trigger a real AWS SES send.** This holds because:

- The test env provides **no AWS credentials**, and the send / test / schedule
  endpoints check for them *before* contacting SES.
- The send-path specs only submit inputs that stop short of the send call —
  malformed bodies (422), a missing audience (422), or a non-existent template
  (404/500). See the header comment in `e2e/send.spec.ts`.
- The dashboard renders its **Send** button disabled when SES is unconfigured,
  which the suite asserts.

The webhook specs never present a valid SNS signature (that needs AWS's private
key), so no event is ever folded into `email_logs`.

---

## 3. Layout

| File | Covers |
| --- | --- |
| `e2e/helpers.ts` | `login()`, `devVar()` (.dev.vars / env reader), name helpers |
| `e2e/auth.spec.ts` | The auth gate: `/` and `/api/email/*` redirect when signed out; public routes stay reachable; login, logout, wrong password, forged cookie |
| `e2e/templates.spec.ts` | `POST /api/email/templates` CRUD (real D1) + validation (422/404) + dashboard dropdown |
| `e2e/send.spec.ts` | send / test / schedule **reject bad input and never send** |
| `e2e/webhooks.spec.ts` | SNS receiver: malformed → 400, unsigned/forged → 403, public |
| `e2e/unsubscribe.spec.ts` | Public opt-out page: reachable, unknown-token branch, noindex |
| `e2e/global-teardown.ts` | Deletes `zz-e2e%` template rows from local D1 |

---

## 4. Conventions worth knowing

**Auth mirrors the main site.** A form login at `/login` issues a signed
session cookie; `src/middleware.ts` verifies it on `/` and `/api/email/*`.
`helpers.login()` drives the real form.

**Test data is prefixed `zz-e2e`.** Template rows created by the CRUD tests use
that name prefix; the tests delete what they create, and `global-teardown.ts`
sweeps any stragglers from the local D1. (CI's D1 is ephemeral — teardown is a
no-op there.)

**Don't seed D1 from a separate process mid-run.** The preview Worker holds the
local SQLite file open, so a concurrent `wrangler d1 execute` races on the lock.
That's why the unsubscribe happy path isn't driven end-to-end here — seed
through the Worker's own connection if you need it.

**CSRF is off by design.** `astro.config.mjs` sets `security.checkOrigin: false`
so AWS SNS (which posts `text/plain` with no `Origin`) can reach the webhook.
`webhooks.spec.ts` guards this: a `text/plain` body must reach the handler
(400/403 from the handler, never a CSRF 403). See the note in §2 of the README.

---

## 5. CI & deploy (`.github/workflows/ci.yml`)

Two jobs:

1. **`e2e`** — on every push and PR: install → `playwright install` → write
   `.dev.vars` with a throwaway `ADMIN_PASSWORD` → `typecheck` → `test:e2e`.
   Uploads the Playwright HTML report as an artifact.
2. **`deploy`** — `needs: [e2e]` (so it runs **only if E2E passed**) and
   `if: push to main`. Builds and runs `wrangler deploy`.

### Required GitHub secrets (for the deploy job)

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token with **Edit Cloudflare Workers** permission (plus D1 + KV if the token is scoped per-resource). |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns the `notify` Worker. |

Set them under **Settings → Secrets and variables → Actions**. The `deploy` job
also references a `production` GitHub **Environment** — create it (optionally
with required reviewers) for a manual approval gate before deploys, or remove
the `environment:` line to skip that.

> Worker runtime secrets (`ADMIN_PASSWORD`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
> `AWS_SECRET_ACCESS_KEY`, `PUBLIC_SITE_URL`) are set once with
> `wrangler secret put` and persist across deploys — the pipeline never touches
> them. See the README and `docs/EMAIL.md`.
