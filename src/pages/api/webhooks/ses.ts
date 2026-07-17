import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { ensureEmailSchema } from "../../../utils/email-db";
import { addSuppression } from "../../../utils/email/suppression";
import {
	isValidSnsUrl,
	verifySnsMessage,
	type SnsMessage,
} from "../../../utils/email/sns-verify";

// Public endpoint (not auth-gated) — SNS posts here. Never prerender.
export const prerender = false;

/**
 * AWS SNS → SES event handler.
 *
 * SNS delivers SubscriptionConfirmation and Notification messages as JSON
 * (often with a text/plain content-type). Every message's signature is
 * verified against its AWS signing cert before we act on it. Notifications
 * carry SES events (Delivery / Bounce / Complaint / Open / Click) which we fold
 * into email_logs, auto-suppressing permanent bounces and complaints.
 */

interface SesEvent {
	eventType?: string;
	notificationType?: string; // some SES payloads use this instead of eventType
	mail?: { messageId?: string };
	bounce?: { bounceType?: string };
	complaint?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
	const db = env.DB as D1Database;

	let sns: SnsMessage;
	try {
		sns = JSON.parse(await request.text()) as SnsMessage;
	} catch {
		return new Response("Bad request", { status: 400 });
	}

	// Reject anything we can't cryptographically trust.
	if (!(await verifySnsMessage(sns))) {
		return new Response("Invalid signature", { status: 403 });
	}

	// A valid signature only proves *some* AWS SNS topic signed the message, not
	// that it is OUR topic. Without this check an attacker could point their own
	// SNS topic at this public endpoint and publish forged SES events. When
	// `SES_TOPIC_ARN` is configured, require an exact match.
	const expectedTopic = (
		env as unknown as Record<string, string | undefined>
	).SES_TOPIC_ARN?.trim();
	if (expectedTopic && sns.TopicArn !== expectedTopic) {
		return new Response("Untrusted topic", { status: 403 });
	}

	// Auto-confirm the subscription by visiting the one-time SubscribeURL.
	// Only do this for our own topic — otherwise confirming an attacker-owned
	// subscription would wire this webhook up to their topic. If `SES_TOPIC_ARN`
	// is unset we can't tell whose topic this is, so we refuse to auto-confirm.
	if (sns.Type === "SubscriptionConfirmation") {
		if (!expectedTopic) {
			console.warn(
				"SNS SubscriptionConfirmation ignored: set SES_TOPIC_ARN to enable auto-confirm",
			);
			return new Response("OK");
		}
		if (!isValidSnsUrl(sns.SubscribeURL)) {
			return new Response("Bad SubscribeURL", { status: 400 });
		}
		await fetch(sns.SubscribeURL);
		return new Response("OK");
	}

	if (sns.Type !== "Notification" || typeof sns.Message !== "string") {
		return new Response("OK");
	}

	let event: SesEvent;
	try {
		event = JSON.parse(sns.Message) as SesEvent;
	} catch {
		return new Response("Bad message", { status: 400 });
	}

	const messageId = event.mail?.messageId;
	if (!messageId) return new Response("OK");

	await ensureEmailSchema(db);

	const log = await db
		.prepare("SELECT id, email FROM email_logs WHERE ses_message_id = ?")
		.bind(messageId)
		.first<{ id: string; email: string }>();
	if (!log) return new Response("Not found", { status: 404 });

	const now = Date.now();
	const eventType = event.eventType ?? event.notificationType;

	switch (eventType) {
		case "Delivery":
			await db
				.prepare("UPDATE email_logs SET status='delivered', delivered_at=? WHERE id=?")
				.bind(now, log.id)
				.run();
			break;

		case "Bounce": {
			const bounceType = event.bounce?.bounceType ?? "Unknown";
			await db
				.prepare("UPDATE email_logs SET status='bounced', bounce_reason=? WHERE id=?")
				.bind(bounceType, log.id)
				.run();
			if (bounceType === "Permanent") {
				await addSuppression(db, log.email, "bounce");
				await db
					.prepare("UPDATE waitlist SET email_status='bounced' WHERE email_norm=?")
					.bind(log.email.toLowerCase())
					.run();
			}
			break;
		}

		case "Complaint":
			await db
				.prepare("UPDATE email_logs SET status='complained' WHERE id=?")
				.bind(log.id)
				.run();
			await addSuppression(db, log.email, "complaint");
			await db
				.prepare("UPDATE waitlist SET email_status='complained' WHERE email_norm=?")
				.bind(log.email.toLowerCase())
				.run();
			break;

		case "Open":
			await db
				.prepare("UPDATE email_logs SET opened_at=COALESCE(opened_at, ?) WHERE id=?")
				.bind(now, log.id)
				.run();
			break;

		case "Click":
			await db
				.prepare("UPDATE email_logs SET clicked_at=COALESCE(clicked_at, ?) WHERE id=?")
				.bind(now, log.id)
				.run();
			break;
	}

	return new Response("OK");
};
