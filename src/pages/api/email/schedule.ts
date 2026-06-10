import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { z } from "zod";
import { ensureEmailSchema } from "../../../utils/email-db";

// Server-rendered, never prerendered. Behind the auth gate in middleware.ts
// (protected prefix: /api/email/*).
export const prerender = false;

const Body = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("create"),
		template_id: z.string().min(1),
		audience: z.enum(["all", "waiting", "invited", "redeemed"]),
		// Absolute Unix ms; the UI computes this from a Utah (America/Denver)
		// wall-clock time the admin enters.
		scheduled_at: z.number().int().positive(),
		variables: z.record(z.string(), z.unknown()).optional(),
	}),
	z.object({ action: z.literal("cancel"), id: z.string().min(1) }),
]);

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

	try {
		if (parsed.action === "cancel") {
			// Only scheduled (not yet sending/sent) campaigns can be cancelled.
			const res = await db
				.prepare(
					"UPDATE email_campaigns SET status = 'canceled' WHERE id = ? AND status = 'scheduled'",
				)
				.bind(parsed.id)
				.run();
			if (!res.meta.changes) {
				return json({ ok: false, error: "Campaign not found or already running." }, 404);
			}
			return json({ ok: true, id: parsed.id });
		}

		// create
		if (parsed.scheduled_at <= Date.now()) {
			return json({ ok: false, error: "Pick a time in the future." }, 422);
		}
		const template = await db
			.prepare("SELECT id FROM email_templates WHERE id = ?")
			.bind(parsed.template_id)
			.first<{ id: string }>();
		if (!template) return json({ ok: false, error: "Template not found." }, 404);

		const id = `cmp-${nanoid()}`;
		await db
			.prepare(
				`INSERT INTO email_campaigns (id, template_id, audience, variables, scheduled_at, status, created_at)
				 VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`,
			)
			.bind(
				id,
				parsed.template_id,
				parsed.audience,
				parsed.variables ? JSON.stringify(parsed.variables) : null,
				parsed.scheduled_at,
				Date.now(),
			)
			.run();
		return json({ ok: true, id, scheduled_at: parsed.scheduled_at });
	} catch (err) {
		console.error("schedule mutation failed", err);
		return json({ ok: false, error: "Database error." }, 500);
	}
};
