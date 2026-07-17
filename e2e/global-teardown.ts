import { execSync } from "node:child_process";
import { E2E_PREFIX } from "./helpers";

/**
 * Remove the template rows the CRUD tests create in the local D1. Rows are
 * matched on the `zz-e2e` name prefix. The suite deletes what it creates, so
 * this is a safety net for tests that fail mid-flight.
 *
 * Local-only, best-effort; never fails the run. CI's D1 is ephemeral, so this
 * is a no-op there.
 */
export default function globalTeardown(): void {
	try {
		execSync(
			`npx wrangler d1 execute curevanails --local --command "DELETE FROM email_templates WHERE name LIKE '${E2E_PREFIX}%'"`,
			{ stdio: "ignore" },
		);
	} catch {
		// Table may not exist yet, or wrangler unavailable — ignore.
	}
}
