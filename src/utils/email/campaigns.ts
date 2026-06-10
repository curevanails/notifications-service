import { env } from "cloudflare:workers";
import { ensureEmailSchema } from "../email-db";
import { createSesClient, sesCredentialsFromEnv } from "./ses-client";
import { sendCampaignByAudience, type Audience } from "./send-service";

/**
 * Scheduled-campaign runner, invoked from the Worker's `scheduled()` handler
 * (a Cron Trigger — see wrangler.jsonc). Picks up campaigns whose time has
 * come and sends them. All scheduling times are stored as absolute Unix ms, so
 * the runner is timezone-agnostic; the admin UI does the America/Denver (Utah)
 * conversion when a campaign is created.
 *
 * Each due campaign is claimed with a conditional UPDATE (status flips
 * scheduled → sending only if it was still scheduled), so overlapping cron
 * ticks can't double-send.
 */

interface CampaignRow {
	id: string;
	template_id: string;
	audience: Audience;
	variables: string | null;
	scheduled_at: number;
}

const MAX_PER_TICK = 5;

export async function runDueCampaigns(): Promise<void> {
	const db = env.DB as D1Database;
	await ensureEmailSchema(db);

	const now = Date.now();
	const due = await db
		.prepare(
			`SELECT id, template_id, audience, variables, scheduled_at
			 FROM email_campaigns
			 WHERE status = 'scheduled' AND scheduled_at <= ?
			 ORDER BY scheduled_at ASC
			 LIMIT ?`,
		)
		.bind(now, MAX_PER_TICK)
		.all<CampaignRow>();

	const campaigns = due.results ?? [];
	if (campaigns.length === 0) return;

	const envRecord = env as unknown as Record<string, unknown>;
	let client: ReturnType<typeof createSesClient>;
	try {
		client = createSesClient(sesCredentialsFromEnv(envRecord));
	} catch (err) {
		// SES not configured — mark the due campaigns failed so they don't spin.
		const message = err instanceof Error ? err.message : "SES not configured.";
		for (const c of campaigns) {
			await markFailed(db, c.id, message);
		}
		return;
	}

	const baseUrl =
		(typeof envRecord.PUBLIC_SITE_URL === "string" && envRecord.PUBLIC_SITE_URL) || "";

	for (const c of campaigns) {
		// Claim it — only proceed if we flipped it from scheduled → sending.
		const claim = await db
			.prepare(
				"UPDATE email_campaigns SET status = 'sending' WHERE id = ? AND status = 'scheduled'",
			)
			.bind(c.id)
			.run();
		if (!claim.meta.changes) continue;

		try {
			const extraVars =
				c.variables && c.variables !== "null"
					? (JSON.parse(c.variables) as Record<string, unknown>)
					: {};
			const result = await sendCampaignByAudience(client, db, {
				templateId: c.template_id,
				audience: c.audience,
				baseUrl,
				extraVars,
			});

			if ("error" in result) {
				await markFailed(db, c.id, result.error);
				continue;
			}

			await db
				.prepare(
					`UPDATE email_campaigns
					 SET status = 'sent', sent_at = ?, total = ?, sent = ?, failed = ?
					 WHERE id = ?`,
				)
				.bind(Date.now(), result.summary.total, result.summary.sent, result.summary.failed, c.id)
				.run();
		} catch (err) {
			const message = err instanceof Error ? err.message : "Send failed.";
			await markFailed(db, c.id, message);
		}
	}
}

async function markFailed(db: D1Database, id: string, message: string): Promise<void> {
	await db
		.prepare("UPDATE email_campaigns SET status = 'failed', error_message = ? WHERE id = ?")
		.bind(message.slice(0, 500), id)
		.run();
}
