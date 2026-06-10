import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { newId } from "./ids";
import { sendEmail } from "./ses-client";
import { renderTemplate, buildUnsubscribeUrl } from "./template-render";

/**
 * Campaign send loop. Renders + sends one email per recipient, logging each to
 * `email_logs`, with a small spacing between sends to stay under the SES rate
 * limit (14/sec). A failed/suppressed recipient is logged and the loop
 * continues.
 *
 * NOTE: this sends inline within the request, which is fine for the Phase 1
 * pre-launch list. Moving the loop behind a Cloudflare Queue consumer (for
 * large lists / retries) is the documented Phase 2 step — `sendOne` is written
 * so a queue consumer can call it per-message unchanged.
 */

const SEND_SPACING_MS = 80; // ≈12/sec, comfortably under the 14/sec SES cap.

export interface Recipient {
	id: string;
	email: string;
	name: string | null;
	unsubscribe_token: string;
	/** Per-recipient discount code, when the waitlist row carries one. */
	discount_code?: string | null;
}

export interface CampaignTemplate {
	id: string;
	subject: string;
	html: string;
	text: string | null;
}

export interface SendSummary {
	total: number;
	sent: number;
	failed: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Render, log, and send a single email. Throws on send failure (the caller logs). */
export async function sendOne(
	client: SESv2Client,
	db: D1Database,
	opts: {
		template: CampaignTemplate;
		recipient: Recipient;
		baseUrl: string;
		extraVars: Record<string, unknown>;
	},
): Promise<void> {
	const { template, recipient, baseUrl, extraVars } = opts;
	const logId = newId();
	const now = Date.now();

	await db
		.prepare(
			`INSERT INTO email_logs (id, subscriber_id, template_id, email, status)
			 VALUES (?, ?, ?, ?, 'queued')`,
		)
		.bind(logId, recipient.id, template.id, recipient.email)
		.run();

	const variables: Record<string, unknown> = {
		name: recipient.name ?? "there",
		email: recipient.email,
		unsubscribe_url: buildUnsubscribeUrl(baseUrl, recipient.unsubscribe_token),
		...(recipient.discount_code ? { discount_code: recipient.discount_code } : {}),
		...extraVars,
	};

	const rendered = renderTemplate(template, variables);

	try {
		const messageId = await sendEmail(client, db, {
			to: recipient.email,
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text,
			logId,
		});
		await db
			.prepare(
				"UPDATE email_logs SET status='sent', sent_at=?, ses_message_id=? WHERE id=?",
			)
			.bind(now, messageId ?? null, logId)
			.run();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await db
			.prepare("UPDATE email_logs SET status='failed', error_message=? WHERE id=?")
			.bind(message.slice(0, 500), logId)
			.run();
		throw err;
	}
}

export async function sendCampaign(
	client: SESv2Client,
	db: D1Database,
	opts: {
		template: CampaignTemplate;
		recipients: Recipient[];
		baseUrl: string;
		extraVars: Record<string, unknown>;
	},
): Promise<SendSummary> {
	let sent = 0;
	let failed = 0;

	for (let i = 0; i < opts.recipients.length; i++) {
		const recipient = opts.recipients[i];
		try {
			await sendOne(client, db, {
				template: opts.template,
				recipient,
				baseUrl: opts.baseUrl,
				extraVars: opts.extraVars,
			});
			sent++;
		} catch {
			// Already logged as failed inside sendOne.
			failed++;
		}
		if (i < opts.recipients.length - 1) await sleep(SEND_SPACING_MS);
	}

	return { total: opts.recipients.length, sent, failed };
}

export type Audience = "all" | "waiting" | "invited" | "redeemed";

/**
 * Resolve a template + an audience of active subscribers and send to all of
 * them. Shared by the immediate `POST /api/email/send` and the scheduled
 * campaign runner, so both behave identically. Returns either a send summary
 * or a human-readable error (template missing / no recipients).
 */
export async function sendCampaignByAudience(
	client: SESv2Client,
	db: D1Database,
	opts: {
		templateId: string;
		audience: Audience;
		baseUrl: string;
		extraVars: Record<string, unknown>;
	},
): Promise<{ summary: SendSummary } | { error: string }> {
	const template = await db
		.prepare("SELECT id, subject, html, text FROM email_templates WHERE id = ?")
		.bind(opts.templateId)
		.first<CampaignTemplate>();
	if (!template) return { error: "Template not found." };

	const res =
		opts.audience === "all"
			? await db
					.prepare(
						`SELECT id, email, NULL AS name, unsubscribe_token, discount_code
						 FROM waitlist WHERE email_status = 'active'`,
					)
					.all<Recipient>()
			: await db
					.prepare(
						`SELECT id, email, NULL AS name, unsubscribe_token, discount_code
						 FROM waitlist WHERE email_status = 'active' AND status = ?`,
					)
					.bind(opts.audience)
					.all<Recipient>();

	const recipients = res.results ?? [];
	if (recipients.length === 0) return { error: "No active recipients matched." };

	const summary = await sendCampaign(client, db, {
		template,
		recipients,
		baseUrl: opts.baseUrl,
		extraVars: opts.extraVars,
	});
	return { summary };
}
