/**
 * Tiny key/value settings store in D1, shared across the CureVà Workers (they
 * all point at the same `curevanails` database). Edited here on the notify
 * dashboard; read by the main site's /api/recruit to decide who gets a
 * "new application" alert. Lazy-created — no migration step.
 */

export const APP_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
)`;

export async function ensureAppSettingsSchema(db: D1Database): Promise<void> {
	await db.prepare(APP_SETTINGS_SCHEMA).run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	await ensureAppSettingsSchema(db);
	const row = await db
		.prepare("SELECT value FROM app_settings WHERE key = ?")
		.bind(key)
		.first<{ value: string | null }>();
	return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	await ensureAppSettingsSchema(db);
	await db
		.prepare(
			`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, Date.now())
		.run();
}

/** Key: comma-separated recipient addresses for new-application alerts. */
export const RECRUIT_NOTIFY_TO = "recruit_notify_to";

/** Parse a comma/space/semicolon-separated address list into clean entries. */
export function parseRecipients(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[,;\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** True when every parsed entry is a syntactically valid address (empty is ok). */
export function recipientsValid(raw: string): boolean {
	return parseRecipients(raw).every((e) => EMAIL_RE.test(e));
}
