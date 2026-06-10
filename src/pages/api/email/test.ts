import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ensureEmailSchema } from "../../../utils/email-db";
import { createSesClient, sesCredentialsFromEnv } from "../../../utils/email/ses-client";
import { sendOne, type CampaignTemplate } from "../../../utils/email/send-service";

// Server-rendered, never prerendered. Behind the auth gate in middleware.ts
// (protected prefix: /api/email/*).
export const prerender = false;

const Body = z.object({
	template_id: z.string().min(1),
	to: z
		.string()
		.trim()
		.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Enter a valid email address."),
	// Optional discount code for templates that use {{discount_code}}.
	discount_code: z.string().trim().optional(),
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
			err instanceof z.ZodError
				? err.issues.map((i) => i.message).join("; ")
				: "Invalid body.";
		return json({ ok: false, error: message }, 422);
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

	const template = await db
		.prepare("SELECT id, subject, html, text FROM email_templates WHERE id = ?")
		.bind(parsed.template_id)
		.first<CampaignTemplate>();
	if (!template) return json({ ok: false, error: "Template not found." }, 404);

	// Public origin for the (placeholder) unsubscribe link in the test email.
	const baseUrl =
		(typeof envRecord.PUBLIC_SITE_URL === "string" && envRecord.PUBLIC_SITE_URL) ||
		new URL(request.url).origin;

	try {
		// A synthetic recipient with sample values, mirroring the live preview.
		await sendOne(client, db, {
			template,
			recipient: {
				id: "test-send",
				email: parsed.to,
				name: "Ava",
				unsubscribe_token: "test-preview",
			},
			baseUrl,
			// Always provide a sample discount code so discount templates render;
			// the user can override it. Unused by templates that don't reference it.
			extraVars: { discount_code: parsed.discount_code || "CUREVA15" },
		});
		return json({ ok: true, to: parsed.to });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Send failed.";
		console.error("test send failed", err);
		return json({ ok: false, error: message }, 502);
	}
};
