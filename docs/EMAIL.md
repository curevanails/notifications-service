# Email infrastructure (AWS SES)

Lets the owner send templated emails (welcome, opening announcement, discount
codes) to the **waitlist** and tracks delivery / bounces / complaints. Built
into the existing CureVà admin — no separate app.

```
 Owner                         Cloudflare (this codebase)                    AWS
 ─────                         ──────────────────────────                    ───
 / (dashboard) ─POST─▶ /api/email/send ─────┬─▶ render (Handlebars)
 (compose UI)                               ├─▶ suppression precheck (D1)
                                            └─▶ SES SendEmail ──────────────▶ SES (cureva-main)
                                                  writes email_logs                  │
                                                                                     ▼ events
 D1 email_logs / suppression_list  ◀──── /api/webhooks/ses ◀──── SNS ◀───── Delivery/Bounce/Complaint/Open/Click
```

## Key idea: the subscriber list **is** the `waitlist` table

The public getready form already populates `waitlist`. We extended that table
with two columns instead of creating a second subscriber store:

- `unsubscribe_token` — unique, unguessable token for the opt-out link (set at
  signup; back-filled for older rows by `ensureWaitlistSchema`)
- `email_status` — `active` | `unsubscribed` | `bounced` | `complained`
  (independent of the pipeline `status` of waiting/invited/redeemed)

## Tables (D1, lazy-created — no migration step)

| Table | Purpose |
| --- | --- |
| `email_templates` | Handlebars templates (`subject`, `html`, `text`, `variables`). Seeded with **Welcome**, **Opening announcement**, **Discount code**. |
| `email_logs` | One row per send: `ses_message_id`, `status`, and `sent/delivered/opened/clicked_at`, `bounce_reason`, `error_message`. |
| `suppression_list` | `email` (PK), `reason` (`bounce`/`complaint`/`unsubscribe`/`manual`), `added_at`. Checked before every send. |

All email timestamps are Unix **milliseconds** (INTEGER).

## Dashboard — `/` (root)

The single **Email** dashboard (this is a standalone, email-only service):

- **Compose & send** — pick a template, pick an audience (All active / Waiting /
  Invited / Redeemed, with live counts), optional shared discount code, send.
- **Preview** — live render with sample values.
- **Templates** — create / edit / delete templates in a modal editor with live
  preview. Handlebars variables (`{{name}}`, `{{discount_code}}`, …) are
  detected automatically and stored on the template. Defaults are seeded only
  on a fresh table, so edits and deletes persist (see `ensureEmailSchema`).
- **Send test** — per template, send one rendered email to an address you type
  (`/api/email/test`), to check it in a real inbox before a campaign.
- **Analytics** — all-time delivery stats over `email_logs` (sent / delivered /
  opened / clicked / bounced / complaints, with rates), plus a per-template
  breakdown. Populated from the SNS event timestamps.
- **Recent sends** — last 50 `email_logs` with status.
- **Suppressed addresses** — the suppression list.

Sending is disabled with a banner until the SES secrets are set (below).

## Secrets (production)

Set on the **admin** Worker (where sending happens). They are **secrets**, not
vars — never commit them:

```bash
wrangler secret put AWS_REGION            --config wrangler.admin.jsonc
wrangler secret put AWS_ACCESS_KEY_ID     --config wrangler.admin.jsonc
wrangler secret put AWS_SECRET_ACCESS_KEY --config wrangler.admin.jsonc
# Optional: public origin used to build unsubscribe links in emails
wrangler secret put PUBLIC_SITE_URL       --config wrangler.admin.jsonc   # e.g. https://curevanails-tech.workers.dev
```

Local dev: uncomment the `AWS_*` lines in `.dev.vars` (gitignored).

Fixed in code (not secrets): From address `CureVà <hello@cureva.vn>`,
Configuration Set `cureva-main` — see `src/utils/email/ses-client.ts`.

## SNS webhook

Point the SES Configuration Set's SNS subscription at:

```
https://notify.curevanails-tech.workers.dev/api/webhooks/ses
```

(The handler is public and only needs the shared D1 — no AWS secrets. It runs
on the always-on main Worker even though sending runs on the admin Worker,
because all three Workers share one D1.)

Every SNS message's **signature is verified** against its AWS signing cert
before it is acted on (`src/utils/email/sns-verify.ts`). The handler
auto-confirms the subscription, marks delivery/open/click, and **auto-suppresses
permanent bounces + complaints** (also flipping the subscriber's `email_status`).

## Unsubscribe

Every email includes `{{unsubscribe_url}}` → `/unsubscribe/<token>` (public,
no auth). Confirming sets `email_status='unsubscribed'` and adds the address to
the suppression list, so it's excluded from future audiences and blocked at
send time.

## Abuse protection

The public `POST /api/waitlist` is rate-limited to **5 signups / 10 min / IP**
(KV-backed, fails open). See `src/utils/rate-limit.ts`.

## Files

| File | Purpose |
| --- | --- |
| `src/utils/email-db.ts` | email tables + default-template seeding |
| `src/utils/waitlist-db.ts` | subscriber schema (`unsubscribe_token`, `email_status`) |
| `src/utils/email/ses-client.ts` | SES send + suppression precheck |
| `src/utils/email/template-render.ts` | Handlebars render + unsubscribe URL |
| `src/utils/email/suppression.ts` | suppression check / add |
| `src/utils/email/sns-verify.ts` | SNS signature verification |
| `src/utils/email/send-service.ts` | throttled campaign loop (≈12/sec) |
| `src/pages/index.astro` | dashboard at `/` — compose / preview / templates / logs |
| `src/pages/api/email/send.ts` | `POST /api/email/send` — campaign send (auth) |
| `src/pages/api/email/templates.ts` | `POST /api/email/templates` — template create/update/delete (auth) |
| `src/pages/api/email/test.ts` | `POST /api/email/test` — single test send (auth) |
| `src/pages/login.astro` · `src/pages/logout.ts` | sign-in / sign-out (`/login`, `/logout`) |
| `src/middleware.ts` | auth gate — protects `/` and `/api/email/*` |
| `src/pages/api/webhooks/ses.ts` | `POST /api/webhooks/ses` (public, SNS) |
| `src/pages/unsubscribe/[token].astro` | public opt-out page |

## Deferred to Phase 2

- **Cloudflare Queues** for send throttling/retries at scale. Today the campaign
  loop sends inline (`send-service.ts`), fine for the pre-launch list; `sendOne`
  is written so a queue consumer can call it per-message unchanged.
- ~~Template editor UI~~ — **done** (`src/pages/api/email/templates.ts` +
  the Templates section in the admin UI). Campaign scheduling (Cron Triggers)
  is still pending.
- ~~Open/click analytics dashboard~~ — **done** (Analytics section in the
  dashboard, aggregated over `email_logs`).
