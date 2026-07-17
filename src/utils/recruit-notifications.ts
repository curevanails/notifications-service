/**
 * Read side of the `recruit_notifications` table. The rows are WRITTEN by the
 * main site's /api/recruit when a candidate applies (see the curevanails repo);
 * here on the notify dashboard we only render them as the "Recruit alerts" list.
 * Both Workers share one D1, so the schema is kept identical and lazily ensured.
 */

export const RECRUIT_NOTIFICATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS recruit_notifications (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  application_id TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  recipients     TEXT,
  status         TEXT NOT NULL,
  error          TEXT,
  ses_message_id TEXT
)`;

export async function ensureRecruitNotificationsSchema(db: D1Database): Promise<void> {
	await db.prepare(RECRUIT_NOTIFICATIONS_SCHEMA).run();
}

export interface RecruitNotification {
	id: string;
	created_at: number;
	application_id: string;
	candidate_name: string;
	recipients: string | null;
	status: string;
	error: string | null;
	ses_message_id: string | null;
}

export async function listRecruitNotifications(
	db: D1Database,
	limit = 100,
): Promise<RecruitNotification[]> {
	await ensureRecruitNotificationsSchema(db);
	const res = await db
		.prepare(
			`SELECT id, created_at, application_id, candidate_name, recipients, status, error, ses_message_id
			 FROM recruit_notifications ORDER BY created_at DESC LIMIT ?`,
		)
		.bind(limit)
		.all<RecruitNotification>();
	return res.results ?? [];
}
