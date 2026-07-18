# notifications-service — Architecture

The CureVà email service: a single Cloudflare Worker (`notify`) that sends
templated email through **AWS SES**, tracks delivery via **AWS SNS**, and gives
the owner a dashboard to compose campaigns, manage templates, and see recruit
alerts. Diagram-first, for humans and AI agents.

> **Key fact:** this Worker shares the **same D1 database** as the main CureVà
> site (`curevanails`, id `fcc8f06b-…`). The `waitlist` table *is* the subscriber
> list; `email_logs` holds every send — including the recruit emails the main
> site sends. No cross-service API calls: the two sides cooperate through D1.

For the platform-wide view (all four Workers), see the main repo's
[`docs/ARCHITECTURE.md`](https://github.com/curevanails/curevanails/blob/main/docs/ARCHITECTURE.md).

---

## 1. Topology

```mermaid
flowchart TB
    owner["🧑‍💼 Owner"]
    subscriber["🙋 Subscriber"]

    subgraph cf["Cloudflare — notify Worker"]
        dash["Dashboard /<br/>compose · templates · analytics"]
        api["/api/email/*<br/>send · test · templates · schedule"]
        settings["/settings · /recruit-alerts"]
        hook["/api/webhooks/ses<br/>(public)"]
        unsub["/unsubscribe/[token]<br/>(public)"]
        cron["Cron */5 min<br/>scheduled()"]
    end

    d1[("D1 · curevanails<br/>shared with main site")]
    ses["AWS SES · cureva-main"]
    sns["AWS SNS"]

    owner -->|auth cookie| dash --> api
    owner --> settings
    subscriber -->|opt out| unsub

    api --> d1
    api -->|SendEmail| ses
    cron --> d1
    cron -->|due campaigns| ses
    ses -->|Delivery/Bounce/Complaint/Open/Click| sns
    sns -->|signed POST| hook --> d1
    settings --> d1
    unsub --> d1

    classDef store fill:#dff1f7,stroke:#3a656e,color:#0d1e22;
    classDef ext fill:#fbeee0,stroke:#b07a5b,color:#241f17;
    class d1 store;
    class ses,sns ext;
```

**Routes at a glance**

| Path | Auth | Purpose |
| --- | --- | --- |
| `/` | 🔒 cookie | dashboard: compose, templates, analytics, activity |
| `/settings` | 🔒 cookie | edit `recruit_notify_to` (recruit-alert recipient) |
| `/recruit-alerts` | 🔒 cookie | list of recruit emails (from `email_logs`) |
| `/api/email/{send,test,templates,schedule}` | 🔒 cookie | campaign actions |
| `/api/settings` | 🔒 cookie | save settings |
| `/login` · `/logout` | public | sign in / out |
| `/unsubscribe/[token]` | public (token) | one-click + on-page opt-out |
| `/api/webhooks/ses` | public (SNS-signed) | delivery events |

Auth is the same signed-cookie scheme as the main site (`src/middleware.ts` +
`src/utils/admin-auth.ts`): protected paths without a valid
`cureva_admin_session` cookie redirect to `/login`; if `ADMIN_PASSWORD` is unset
the dashboard 404s.

---

## 2. Campaign send flow

Composing and sending to an audience of active subscribers.

```mermaid
sequenceDiagram
    autonumber
    actor O as Owner
    participant D as Dashboard /
    participant S as POST /api/email/send
    participant DB as D1
    participant SES as AWS SES

    O->>D: pick template + audience, Send
    D->>S: JSON { template_id, audience }
    S->>S: validate; build SES client (500 if secrets unset)
    S->>DB: load template + resolve recipients<br/>(waitlist where email_status='active')
    loop each recipient (≈12/sec)
        S->>DB: INSERT email_logs (queued)
        S->>DB: suppression precheck
        S->>SES: SendEmail (+ List-Unsubscribe headers)
        S->>DB: UPDATE email_logs (sent / failed)
    end
    S-->>D: summary { total, sent, failed }
```

- **`sendOne`** (`src/utils/email/send-service.ts`) is the unit of work: render
  (Handlebars) → log → send → update. It is reused by immediate sends, scheduled
  sends, and the main site's recruit emails, so all behave identically.
- **Suppression is checked before every send** — unsubscribed / bounced /
  complained addresses are never emailed.
- Sends are spaced (~80 ms) to stay under the SES rate limit.

### Scheduled campaigns (Cron)

```mermaid
flowchart LR
    cron["Cron trigger */5 min"] --> due["find due campaigns<br/>(scheduled_at ≤ now)"]
    due --> claim["claim: status scheduled → sending<br/>(conditional UPDATE, no double-send)"]
    claim --> send["sendCampaignByAudience → sendOne loop"]
    send --> done["status → sent, write counts"]
```

Scheduling times are stored as absolute Unix-ms, so the runner is
timezone-agnostic; the dashboard does the Utah (America/Denver) conversion when a
campaign is created.

---

## 3. SES → SNS event flow (delivery tracking)

Every send is later reconciled with what actually happened, via signed SNS
notifications.

```mermaid
sequenceDiagram
    autonumber
    participant SES as AWS SES
    participant SNS as AWS SNS
    participant H as POST /api/webhooks/ses
    participant V as sns-verify.ts
    participant DB as D1

    SES->>SNS: Delivery / Bounce / Complaint / Open / Click
    SNS->>H: POST message (text/plain, no Origin)
    H->>V: verify signature vs AWS signing cert
    alt invalid signature
        V-->>H: reject → 403
    else valid
        H->>DB: match ses_message_id in email_logs
        H->>DB: update status / delivered_at / opened_at ...
        opt permanent bounce or complaint
            H->>DB: add to suppression_list
            H->>DB: waitlist.email_status = bounced/complained
        end
    end
```

- **Signature verification is mandatory** (`sns-verify.ts`, WebCrypto, no deps)
  before any event is acted on — the endpoint is public, so the signature is the
  trust boundary.
- CSRF `checkOrigin` is **disabled** (`astro.config.mjs`) precisely because SNS
  posts `text/plain` with no `Origin`; without that, every event would be
  rejected with a 403. Protection is the signature + auth gate instead.

---

## 4. Unsubscribe (link + one-click)

```mermaid
flowchart TD
    email["Email footer link<br/>+ List-Unsubscribe header"] --> path["/unsubscribe/&lt;token&gt;"]
    path --> get{"method?"}
    get -->|GET| page["confirm page"] -->|Yes| post
    get -->|POST| post["mark email_status=unsubscribed<br/>+ add suppression"]
    post --> done["done — excluded from future sends"]

    oneclick["Gmail/Yahoo one-click<br/>POST List-Unsubscribe=One-Click"] --> path
```

- Every email carries `{{unsubscribe_url}}` **and** the RFC 8058 headers
  `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, which
  render the native Unsubscribe button in Gmail/Apple Mail (required for bulk
  senders). See [`EMAIL.md`](EMAIL.md).
- The token is the credential — no login. One-click and on-page both hit the
  same handler.

---

## 5. Recruit alerts (cross-repo, via shared D1)

The main site sends the recruiter alert + candidate acknowledgement (as system
templates) through the shared send path, so they land in `email_logs`. This
dashboard just surfaces them.

```mermaid
flowchart LR
    subgraph main["Main site (curevanails repo)"]
        apply["/api/recruit"] -->|sendOne| logs
    end
    settings[["/settings<br/>recruit_notify_to"]] -.reads.-> apply
    subgraph notify["notify (this repo)"]
        list["/recruit-alerts"]
    end
    logs[("email_logs<br/>template_id IN<br/>tpl-recruit-alert, tpl-recruit-ack")]
    logs --> list
    ja[("job_applications")] -.join for name.-> list

    classDef store fill:#dff1f7,stroke:#3a656e,color:#0d1e22;
    class logs,ja store;
```

- **`/settings`** edits `recruit_notify_to` in the shared `app_settings` table;
  the main site reads it to decide who gets the recruiter alert.
- **`/recruit-alerts`** reads `email_logs` filtered to the two recruit template
  ids, joined to `job_applications` for the candidate name (falls back to a
  name-less list if that table isn't present yet).

---

## 6. Data model (email tables)

```mermaid
erDiagram
    email_templates {
        TEXT id PK "tpl-welcome, tpl-recruit-alert, ..."
        TEXT name
        TEXT subject
        TEXT html
        TEXT text
        TEXT variables "JSON"
    }
    email_logs {
        TEXT id PK
        TEXT subscriber_id "waitlist id or application id"
        TEXT template_id
        TEXT email "recipient"
        TEXT ses_message_id "matched by SNS"
        TEXT status "queued|sent|delivered|bounced|complained|failed"
        INTEGER sent_at
        INTEGER delivered_at
        INTEGER opened_at
        INTEGER clicked_at
    }
    suppression_list {
        TEXT email PK
        TEXT reason "bounce|complaint|unsubscribe|manual"
        INTEGER added_at
    }
    email_campaigns {
        TEXT id PK
        TEXT template_id
        TEXT audience "all|waiting|invited|redeemed"
        INTEGER scheduled_at
        TEXT status "scheduled|sending|sent|canceled"
    }
    waitlist {
        TEXT id PK
        TEXT email
        TEXT email_norm UK
        TEXT unsubscribe_token UK
        TEXT email_status "active|unsubscribed|bounced|complained"
    }
    app_settings {
        TEXT key PK "recruit_notify_to"
        TEXT value
        INTEGER updated_at
    }

    email_templates ||..o{ email_logs : template_id
    email_templates ||..o{ email_campaigns : template_id
    waitlist        ||..o{ email_logs : "campaign send"
    waitlist        ||..o{ suppression_list : email
```

All tables are lazily created (`ensureEmailSchema`, `app-settings.ts`) — no
migration step. Email timestamps are Unix-ms integers.

---

## 7. Where things live

```
src/
├─ middleware.ts                 auth gate (/ , /settings, /recruit-alerts, /api/*)
├─ pages/
│  ├─ index.astro                dashboard: compose / templates / analytics / activity
│  ├─ settings.astro             edit recruit_notify_to
│  ├─ recruit-alerts.astro       recruit emails list (reads email_logs)
│  ├─ login.astro · logout.ts    auth
│  ├─ unsubscribe/[token].astro  public opt-out (link + one-click POST)
│  └─ api/
│     ├─ email/{send,test,templates,schedule}.ts   campaign actions
│     ├─ settings.ts             save settings
│     └─ webhooks/ses.ts         SNS receiver (signed)
├─ utils/
│  ├─ email-db.ts                email tables + default/system templates
│  ├─ app-settings.ts            shared key/value store
│  ├─ recruit-notifications.ts   read recruit emails from email_logs
│  └─ email/
│     ├─ ses-client.ts           SES send + List-Unsubscribe + suppression precheck
│     ├─ send-service.ts         sendOne + campaign loop
│     ├─ campaigns.ts            cron: run due scheduled campaigns
│     └─ sns-verify.ts           SNS signature verification
└─ worker.ts                     fetch + scheduled() (cron) handlers
```

---

## 8. Deep-dive docs

| Doc | Covers |
| --- | --- |
| [`EMAIL.md`](EMAIL.md) | SES setup, templates, secrets, SNS webhook, unsubscribe, one-click |
| [`TESTING.md`](TESTING.md) | Playwright E2E suite + the deploy-after-E2E pipeline |
| main repo `docs/ARCHITECTURE.md` | The whole platform (four Workers, recruit flow) |

> Diagrams are [Mermaid](https://mermaid.js.org/) blocks — GitHub and most
> Markdown viewers render them natively, no build step.
