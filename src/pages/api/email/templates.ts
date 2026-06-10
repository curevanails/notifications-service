import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { z } from "zod";
import { ensureEmailSchema } from "../../../utils/email-db";

// Server-rendered, never prerendered. Behind the auth gate in middleware.ts
// (protected prefix: /api/email/*).
export const prerender = false;

// Shared editable fields for create/update.
const fields = {
	name: z.string().trim().min(1, "Name is required.").max(120),
	subject: z.string().trim().min(1, "Subject is required.").max(300),
	html: z.string().trim().min(1, "HTML body is required."),
	text: z.string().nullish(),
};

const Body = z.discriminatedUnion("action", [
	z.object({ action: z.literal("create"), ...fields }),
	z.object({ action: z.literal("update"), id: z.string().min(1), ...fields }),
	z.object({ action: z.literal("delete"), id: z.string().min(1) }),
]);

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface TemplateListRow {
	id: string;
	name: string;
	subject: string;
	html: string;
}

/** The current template list, in the same shape/order the page renders. */
async function listTemplates(db: D1Database): Promise<TemplateListRow[]> {
	const res = await db
		.prepare("SELECT id, name, subject, html FROM email_templates ORDER BY name")
		.all<TemplateListRow>();
	return res.results ?? [];
}

/**
 * Pull the Handlebars variables a template references (`{{name}}`,
 * `{{discount_code}}`, …) so they're stored alongside it. Block helpers like
 * `{{#each}}` / `{{/each}}` start with a non-word char and are skipped.
 */
function extractVariables(...parts: string[]): string[] {
	const re = /\{\{\s*([\w.]+)\s*\}\}/g;
	const found = new Set<string>();
	for (const part of parts) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(part)) !== null) found.add(m[1]);
	}
	return [...found];
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
		if (parsed.action === "delete") {
			const res = await db
				.prepare("DELETE FROM email_templates WHERE id = ?")
				.bind(parsed.id)
				.run();
			if (!res.meta.changes) {
				return json({ ok: false, error: "Template not found." }, 404);
			}
			return json({ ok: true, id: parsed.id, templates: await listTemplates(db) });
		}

		const now = Date.now();
		const variables = JSON.stringify(
			extractVariables(parsed.subject, parsed.html, parsed.text ?? ""),
		);

		if (parsed.action === "create") {
			const id = `tpl-${nanoid()}`;
			await db
				.prepare(
					`INSERT INTO email_templates (id, name, subject, html, text, variables, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					id,
					parsed.name,
					parsed.subject,
					parsed.html,
					parsed.text ?? null,
					variables,
					now,
					now,
				)
				.run();
			return json({ ok: true, id, templates: await listTemplates(db) });
		}

		// update
		const res = await db
			.prepare(
				`UPDATE email_templates
				 SET name = ?, subject = ?, html = ?, text = ?, variables = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.bind(
				parsed.name,
				parsed.subject,
				parsed.html,
				parsed.text ?? null,
				variables,
				now,
				parsed.id,
			)
			.run();
		if (!res.meta.changes) {
			return json({ ok: false, error: "Template not found." }, 404);
		}
		return json({ ok: true, id: parsed.id, templates: await listTemplates(db) });
	} catch (err) {
		console.error("template mutation failed", err);
		return json({ ok: false, error: "Database error." }, 500);
	}
};
