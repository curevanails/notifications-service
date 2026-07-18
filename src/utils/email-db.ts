/**
 * Schema + helpers for the email infrastructure (templates, send logs,
 * suppression) plus the email-subscription columns added to `waitlist`.
 *
 * Follows the project's lazy `ensure…Schema` convention (no migration step):
 * `ensureEmailSchema` is idempotent — it creates the email tables, back-fills
 * the new `waitlist` columns, generates unsubscribe tokens for existing rows,
 * and seeds the default templates on first run.
 *
 * The existing `waitlist` table IS the subscriber list (the public getready
 * form already feeds it). We extend it with:
 *   - `unsubscribe_token`  unique, unguessable token for the public opt-out link
 *   - `email_status`       active | unsubscribed | bounced | complained
 * `email_status` is independent of the pipeline `status`
 * (waiting/invited/redeemed) — one tracks deliverability, the other the funnel.
 *
 * Timestamps in the email tables are Unix milliseconds (INTEGER), per the
 * email-infra spec. (The older recruit/waitlist columns use ISO strings; we
 * keep each domain internally consistent rather than rewrite history.)
 */

import { ensureWaitlistSchema } from "./waitlist-db";

// ---- Email-subscription status (on `waitlist`) ----
export const EMAIL_STATUSES = [
	"active",
	"unsubscribed",
	"bounced",
	"complained",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export function isEmailStatus(v: unknown): v is EmailStatus {
	return typeof v === "string" && (EMAIL_STATUSES as readonly string[]).includes(v);
}

// ---- Email-log delivery status ----
export const LOG_STATUSES = [
	"queued",
	"sent",
	"delivered",
	"bounced",
	"complained",
	"failed",
] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

// ---- Suppression reasons ----
export type SuppressionReason = "bounce" | "complaint" | "manual" | "unsubscribe";

const CREATE_TEMPLATES = `
CREATE TABLE IF NOT EXISTS email_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  html        TEXT NOT NULL,
  text        TEXT,
  variables   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`;

const CREATE_LOGS = `
CREATE TABLE IF NOT EXISTS email_logs (
  id             TEXT PRIMARY KEY,
  subscriber_id  TEXT,
  template_id    TEXT,
  email          TEXT NOT NULL,
  ses_message_id TEXT,
  status         TEXT NOT NULL,
  sent_at        INTEGER,
  delivered_at   INTEGER,
  opened_at      INTEGER,
  clicked_at     INTEGER,
  bounce_reason  TEXT,
  error_message  TEXT
)`;

const CREATE_LOGS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_logs_ses_msg ON email_logs(ses_message_id)`;

const CREATE_SUPPRESSION = `
CREATE TABLE IF NOT EXISTS suppression_list (
  email     TEXT PRIMARY KEY,
  reason    TEXT NOT NULL,
  added_at  INTEGER NOT NULL
)`;

const CREATE_CAMPAIGNS = `
CREATE TABLE IF NOT EXISTS email_campaigns (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL,
  audience      TEXT NOT NULL,
  variables     TEXT,
  scheduled_at  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled',
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  total         INTEGER,
  sent          INTEGER,
  failed        INTEGER,
  error_message TEXT
)`;

const CREATE_CAMPAIGNS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_campaigns_due ON email_campaigns(status, scheduled_at)`;

/**
 * Create the email tables and seed default templates. Also ensures the
 * `waitlist` table (the subscriber list) exists with its email columns +
 * back-filled unsubscribe tokens, by delegating to `ensureWaitlistSchema`.
 * Idempotent — safe to call on every relevant request.
 */
export async function ensureEmailSchema(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(CREATE_TEMPLATES),
		db.prepare(CREATE_LOGS),
		db.prepare(CREATE_LOGS_INDEX),
		db.prepare(CREATE_SUPPRESSION),
		db.prepare(CREATE_CAMPAIGNS),
		db.prepare(CREATE_CAMPAIGNS_INDEX),
	]);

	// The subscriber list IS the waitlist table — ensure it (and its
	// unsubscribe_token / email_status columns + token back-fill) exists.
	await ensureWaitlistSchema(db);

	await seedDefaultTemplates(db);
	await ensureSystemTemplates(db);
}

// ---- Default templates ----------------------------------------------------

const UNSUB_FOOTER = `<p style="margin-top:32px;font-size:12px;color:#94a3b8;text-align:center">
  You're receiving this because you joined the CureVà waitlist.
  <a href="{{unsubscribe_url}}" style="color:#3a656e">Unsubscribe</a>.
</p>`;

interface SeedTemplate {
	id: string;
	name: string;
	subject: string;
	html: string;
	variables: string[];
}

const DEFAULT_TEMPLATES: SeedTemplate[] = [
	{
		id: "tpl-welcome",
		name: "Welcome to the waitlist",
		subject: "You're on the CureVà list ✨",
		variables: ["name", "unsubscribe_url"],
		html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#0d1e22">
  <h1 style="color:#3a656e;font-size:28px">Welcome, {{name}}.</h1>
  <p style="font-size:16px;line-height:1.6">Thank you for joining the CureVà waitlist. We're building a premium beauty &amp; wellness lounge around stillness — five Zero Gravity chairs, pregnancy-safe formulas, and a space designed to lower your cortisol the moment you walk in.</p>
  <p style="font-size:16px;line-height:1.6">We'll be in touch with opening news and an early-bird perk before our September 2026 launch.</p>
  ${UNSUB_FOOTER}
</div>`,
	},
	{
		id: "tpl-opening",
		name: "Opening announcement",
		subject: "CureVà opens soon — your priority access",
		variables: ["name", "unsubscribe_url"],
		html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#0d1e22">
  <h1 style="color:#3a656e;font-size:28px">It's almost time, {{name}}.</h1>
  <p style="font-size:16px;line-height:1.6">CureVà is opening its doors. As a waitlist member you get priority booking before we open to the public.</p>
  <p style="font-size:16px;line-height:1.6">Watch this inbox — booking details are on the way.</p>
  ${UNSUB_FOOTER}
</div>`,
	},
	{
		id: "tpl-discount",
		name: "Discount code",
		subject: "A little something for joining early 🎁",
		variables: ["name", "discount_code", "unsubscribe_url"],
		html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#0d1e22">
  <h1 style="color:#3a656e;font-size:28px">Thank you, {{name}}.</h1>
  <p style="font-size:16px;line-height:1.6">Here's your early-bird code to use on your first visit:</p>
  <p style="font-size:24px;font-weight:700;letter-spacing:2px;text-align:center;background:#dff1f7;color:#3a656e;padding:16px;border-radius:12px">{{discount_code}}</p>
  <p style="font-size:14px;line-height:1.6;color:#41484a">Present it at checkout when CureVà opens.</p>
  ${UNSUB_FOOTER}
</div>`,
	},
];

/**
 * Seed the default templates, but only on a *fresh* table. Once any template
 * exists — whether a seeded default, an edited one, or a user-created one —
 * we never re-insert, so deleting a default in the template editor sticks
 * (otherwise it would silently reappear on the next page load).
 */
async function seedDefaultTemplates(db: D1Database): Promise<void> {
	const existing = await db
		.prepare("SELECT id FROM email_templates LIMIT 1")
		.first<{ id: string }>();
	if (existing) return;

	const now = Date.now();
	for (const t of DEFAULT_TEMPLATES) {
		await db
			.prepare(
				`INSERT INTO email_templates (id, name, subject, html, text, variables, created_at, updated_at)
				 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
			)
			.bind(t.id, t.name, t.subject, t.html, JSON.stringify(t.variables), now, now)
			.run();
	}
}

// ---- System templates -----------------------------------------------------
// App-owned transactional templates that must ALWAYS exist for a feature to
// work — unlike the marketing DEFAULT_TEMPLATES, which the operator manages and
// may delete. These are ensured by id on every schema check (INSERT OR IGNORE),
// so the recruit-alert email always has a body to render. Both Workers share
// one D1 and both ensure these, so the definition is kept identical.

const SYSTEM_TEMPLATES: SeedTemplate[] = [
	{
		id: "tpl-recruit-alert",
		name: "Recruit alert (new application)",
		subject: "New application: {{candidate_name}} — {{positions}}",
		variables: [
			"candidate_name",
			"positions",
			"email",
			"phone",
			"current_status",
			"background",
			"employment_type",
			"graduation_date",
			"portfolio_link",
			"why_cureva",
			"applied_at",
			"dashboard_url",
		],
		html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#0d1e22;background:#f0fbff">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#3a656e;font-weight:600">CureVà · New application</p>
  <h1 style="margin:0 0 4px;color:#0d1e22;font-size:26px">{{candidate_name}}</h1>
  <p style="margin:0 0 24px;font-size:16px;color:#3a656e;font-weight:600">{{positions}}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5">
    {{#if email}}<tr><td style="padding:8px 0;color:#6b7280;width:150px">Email</td><td style="padding:8px 0"><a href="mailto:{{email}}" style="color:#3a656e">{{email}}</a></td></tr>{{/if}}
    <tr><td style="padding:8px 0;color:#6b7280;width:150px">Phone</td><td style="padding:8px 0"><a href="tel:{{phone}}" style="color:#3a656e">{{phone}}</a></td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Current status</td><td style="padding:8px 0">{{current_status}}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Background</td><td style="padding:8px 0">{{background}}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Employment type</td><td style="padding:8px 0">{{employment_type}}</td></tr>
    {{#if graduation_date}}<tr><td style="padding:8px 0;color:#6b7280">Graduation</td><td style="padding:8px 0">{{graduation_date}}</td></tr>{{/if}}
    {{#if portfolio_link}}<tr><td style="padding:8px 0;color:#6b7280">Portfolio</td><td style="padding:8px 0"><a href="{{portfolio_link}}" style="color:#3a656e">{{portfolio_link}}</a></td></tr>{{/if}}
    {{#if applied_at}}<tr><td style="padding:8px 0;color:#6b7280">Applied</td><td style="padding:8px 0">{{applied_at}}</td></tr>{{/if}}
  </table>
  {{#if why_cureva}}<div style="margin-top:24px">
    <p style="margin:0 0 6px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Why CureVà</p>
    <blockquote style="margin:0;padding:14px 18px;border-left:3px solid #3a656e;background:#dff1f7;border-radius:8px;font-size:15px;line-height:1.6;color:#0d1e22">{{why_cureva}}</blockquote>
  </div>{{/if}}
  {{#if dashboard_url}}<p style="margin-top:28px">
    <a href="{{dashboard_url}}" style="display:inline-block;background:#3a656e;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">Review in dashboard →</a>
  </p>{{/if}}
  <p style="margin-top:28px;font-size:12px;color:#94a3b8">Internal recruiting notification — no unsubscribe. Reply to reach the candidate{{#if email}} at {{email}}{{/if}}.</p>
</div>`,
	},
];

/**
 * Ensure every system template exists, by id, without disturbing operator
 * edits. INSERT OR IGNORE is a no-op when the row is already present, so this is
 * safe to run on every schema check and from either Worker.
 */
async function ensureSystemTemplates(db: D1Database): Promise<void> {
	const now = Date.now();
	for (const t of SYSTEM_TEMPLATES) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO email_templates (id, name, subject, html, text, variables, created_at, updated_at)
				 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
			)
			.bind(t.id, t.name, t.subject, t.html, JSON.stringify(t.variables), now, now)
			.run();
	}
}
