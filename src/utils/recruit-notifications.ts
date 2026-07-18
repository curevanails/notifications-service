/**
 * Read side of the "Recruit alerts" list.
 *
 * Recruit emails (the recruiter alert `tpl-recruit-alert` and the candidate
 * acknowledgement `tpl-recruit-ack`) are sent by the main site's /api/recruit
 * through the shared send path, so they land in `email_logs` like any other
 * send. Here we surface just those, joined to `job_applications` for the
 * candidate's name. Both Workers share one D1.
 */

import { ensureEmailSchema } from "./email-db";

/** Template ids that represent a recruit email. */
export const RECRUIT_TEMPLATE_IDS = ["tpl-recruit-alert", "tpl-recruit-ack"] as const;

export interface RecruitEmail {
	id: string;
	template_id: string | null;
	recipient: string; // the address the email went to
	status: string;
	sent_at: number | null;
	error_message: string | null;
	candidate_name: string | null;
}

/** Human label for the two recruit template kinds. */
export function recruitKind(templateId: string | null): "Recruiter alert" | "Candidate ack" | "—" {
	if (templateId === "tpl-recruit-alert") return "Recruiter alert";
	if (templateId === "tpl-recruit-ack") return "Candidate ack";
	return "—";
}

const SELECT = `l.id, l.template_id, l.email AS recipient, l.status, l.sent_at, l.error_message`;
const WHERE = `l.template_id IN ('tpl-recruit-alert','tpl-recruit-ack')`;

export async function listRecruitEmails(db: D1Database, limit = 200): Promise<RecruitEmail[]> {
	// Guarantees email_logs (+ the system templates) exist.
	await ensureEmailSchema(db);

	// Prefer the join so we can show the candidate's name. job_applications is
	// created by the main site; if it doesn't exist here yet, fall back to a
	// name-less list rather than error.
	try {
		const res = await db
			.prepare(
				`SELECT ${SELECT}, (a.first_name || ' ' || a.last_name) AS candidate_name
				 FROM email_logs l
				 LEFT JOIN job_applications a ON a.id = l.subscriber_id
				 WHERE ${WHERE}
				 ORDER BY COALESCE(l.sent_at, 0) DESC LIMIT ?`,
			)
			.bind(limit)
			.all<RecruitEmail>();
		return res.results ?? [];
	} catch {
		const res = await db
			.prepare(
				`SELECT ${SELECT}, NULL AS candidate_name
				 FROM email_logs l WHERE ${WHERE}
				 ORDER BY COALESCE(l.sent_at, 0) DESC LIMIT ?`,
			)
			.bind(limit)
			.all<RecruitEmail>();
		return res.results ?? [];
	}
}
