import type { SuppressionReason } from "../email-db";

/**
 * Suppression-list helpers. The list is the source of truth for "never send to
 * this address" — populated by hard bounces, complaints, and manual additions.
 * Every send must pass through `isSuppressed` first.
 */

export async function isSuppressed(
	db: D1Database,
	email: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS hit FROM suppression_list WHERE email = ?")
		.bind(email.toLowerCase())
		.first<{ hit: number }>();
	return row != null;
}

export async function addSuppression(
	db: D1Database,
	email: string,
	reason: SuppressionReason,
): Promise<void> {
	await db
		.prepare(
			"INSERT OR IGNORE INTO suppression_list (email, reason, added_at) VALUES (?, ?, ?)",
		)
		.bind(email.toLowerCase(), reason, Date.now())
		.run();
}
