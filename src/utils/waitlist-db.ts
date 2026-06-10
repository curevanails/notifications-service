/**
 * Shared schema + helpers for the `waitlist` table.
 *
 * The table is created lazily (no migration step) so the waitlist endpoint
 * stays self-contained — mirroring `recruit-db.ts`. `ensureWaitlistSchema` is
 * idempotent and back-fills columns introduced after the table first appeared.
 *
 * Capture-only for now: we store phone + email. The `discount_code`,
 * `claimed_at`, and `status` columns are the seam for the later
 * "claim a discount code" feature (and a possible Mangomint sync) — they cost
 * nothing to add now and save an `ALTER TABLE` later.
 */

import { nanoid } from "nanoid";

/** A new unsubscribe token (URL-safe, unguessable) for a subscriber. */
export function newUnsubscribeToken(): string {
	return nanoid(32);
}

export const WAITLIST_STATUSES = ["waiting", "invited", "redeemed"] as const;

export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const WAITLIST_STATUS_LABELS: Record<WaitlistStatus, string> = {
	waiting: "Waiting",
	invited: "Invited",
	redeemed: "Redeemed",
};

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS waitlist (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email_norm    TEXT NOT NULL,
  phone_norm    TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'getready',
  status        TEXT NOT NULL DEFAULT 'waiting',
  discount_code TEXT,
  claimed_at    TEXT,
  notes         TEXT,
  unsubscribe_token TEXT,
  email_status  TEXT NOT NULL DEFAULT 'active'
)`;

const CREATE_EMAIL_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist (email_norm)`;

/** Create the table + unique-email index if missing, adding later columns. */
export async function ensureWaitlistSchema(db: D1Database): Promise<void> {
	await db.prepare(CREATE_TABLE).run();

	const info = await db.prepare("PRAGMA table_info(waitlist)").all();
	const columns = new Set(
		(info.results ?? []).map((row) => (row as { name: string }).name),
	);

	if (!columns.has("status")) {
		await db
			.prepare(
				"ALTER TABLE waitlist ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting'",
			)
			.run();
	}
	if (!columns.has("discount_code")) {
		await db.prepare("ALTER TABLE waitlist ADD COLUMN discount_code TEXT").run();
	}
	if (!columns.has("claimed_at")) {
		await db.prepare("ALTER TABLE waitlist ADD COLUMN claimed_at TEXT").run();
	}
	if (!columns.has("notes")) {
		await db.prepare("ALTER TABLE waitlist ADD COLUMN notes TEXT").run();
	}
	if (!columns.has("unsubscribe_token")) {
		await db.prepare("ALTER TABLE waitlist ADD COLUMN unsubscribe_token TEXT").run();
	}
	if (!columns.has("email_status")) {
		await db
			.prepare("ALTER TABLE waitlist ADD COLUMN email_status TEXT NOT NULL DEFAULT 'active'")
			.run();
	}

	await db.prepare(CREATE_EMAIL_INDEX).run();

	// Back-fill unsubscribe tokens for any rows created before the column existed.
	const missing = await db
		.prepare("SELECT id FROM waitlist WHERE unsubscribe_token IS NULL OR unsubscribe_token = ''")
		.all<{ id: string }>();
	for (const row of missing.results ?? []) {
		await db
			.prepare("UPDATE waitlist SET unsubscribe_token = ? WHERE id = ?")
			.bind(newUnsubscribeToken(), row.id)
			.run();
	}
}

export function isWaitlistStatus(v: unknown): v is WaitlistStatus {
	return (
		typeof v === "string" &&
		(WAITLIST_STATUSES as readonly string[]).includes(v)
	);
}

/** Lowercase + trim, for case-insensitive dedupe of email addresses. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Digits only, for dedupe-friendly phone storage. */
export function normalizePhone(phone: string): string {
	return phone.replace(/\D/g, "");
}
