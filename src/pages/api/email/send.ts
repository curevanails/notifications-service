import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ensureEmailSchema } from "../../../utils/email-db";
import { createSesClient, sesCredentialsFromEnv } from "../../../utils/email/ses-client";
import {
	sendCampaign,
	type CampaignTemplate,
	type Recipient,
} from "../../../utils/email/send-service";

// Server-rendered, never prerendered. Behind the auth gate in middleware.ts
// (protected prefix: /api/email/*).
export const prerender = false;

const Body = z.object({
	template_id: z.string().min(1),
	// Either explicit waitlist ids, or an audience selector resolved server-side.
	subscriber_ids: z.array(z.string().min(1)).optional(),
	audience: z.enum(["all", "waiting", "invited", "redeemed"]).optional(),
	// Extra Handlebars vars merged into every send (e.g. a shared discount_code).
	variables: z.record(z.string(), z.unknown()).optional(),
});

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export const POST: APIRoute = async ({ request }) => {
	const db = env.DB as D1Database;

	let parsed: z.infer<typeof Body>;
	try {
		parsed = Body.parse(await request.json());
	} catch (err) {
		const message =
			err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Invalid body.";
		return json({ ok: false, error: message }, 422);
	}

	if (!parsed.subscriber_ids?.length && !parsed.audience) {
		return json(
			{ ok: false, error: "Provide subscriber_ids or an audience." },
			422,
		);
	}

	await ensureEmailSchema(db);

	const envRecord = env as unknown as Record<string, unknown>;

	// SES credentials — 500 with a clear message if the secrets aren't set.
	let client: ReturnType<typeof createSesClient>;
	try {
		client = createSesClient(sesCredentialsFromEnv(envRecord));
	} catch (err) {
		return json(
			{ ok: false, error: err instanceof Error ? err.message : "SES not configured." },
			500,
		);
	}

	// Load the template.
	const template = await db
		.prepare("SELECT id, subject, html, text FROM email_templates WHERE id = ?")
		.bind(parsed.template_id)
		.first<CampaignTemplate>();
	if (!template) return json({ ok: false, error: "Template not found." }, 404);

	// Resolve recipients from the waitlist (active subscribers only).
	let recipients: Recipient[];
	if (parsed.subscriber_ids?.length) {
		const placeholders = parsed.subscriber_ids.map(() => "?").join(",");
		const res = await db
			.prepare(
				`SELECT id, email, NULL AS name, unsubscribe_token, discount_code
				 FROM waitlist
				 WHERE id IN (${placeholders}) AND email_status = 'active'`,
			)
			.bind(...parsed.subscriber_ids)
			.all<Recipient>();
		recipients = res.results ?? [];
	} else {
		const audience = parsed.audience as string;
		const res =
			audience === "all"
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
						.bind(audience)
						.all<Recipient>();
		recipients = res.results ?? [];
	}

	if (recipients.length === 0) {
		return json({ ok: false, error: "No active recipients matched." }, 422);
	}

	// Public origin for unsubscribe links: explicit env, else this request's origin.
	const baseUrl =
		(typeof envRecord.PUBLIC_SITE_URL === "string" && envRecord.PUBLIC_SITE_URL) ||
		new URL(request.url).origin;

	try {
		const summary = await sendCampaign(client, db, {
			template,
			recipients,
			baseUrl,
			extraVars: parsed.variables ?? {},
		});
		return json({ ok: true, ...summary });
	} catch (err) {
		console.error("email send failed", err);
		return json({ ok: false, error: "Send failed." }, 500);
	}
};
