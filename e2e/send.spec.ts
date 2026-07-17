import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, login } from "./helpers";

/**
 * Safety coverage for the endpoints that CAN dispatch mail — `/api/email/send`,
 * `/api/email/test`, `/api/email/schedule`.
 *
 * ⚠️  No test here may cause a real AWS SES send. That invariant is upheld two
 * ways, both grounded in the endpoints' control flow (see the source):
 *   1. Malformed bodies fail Zod validation (422) and the audience/ids guard
 *      (422) BEFORE any SES client is built.
 *   2. A well-formed body that names a NON-EXISTENT template can never reach
 *      the send call: the endpoint either 500s at the SES-credential check
 *      (creds absent, as in this test env) or 404s at the template lookup
 *      (creds present) — in both branches `sendOne`/`sendCampaign` is never
 *      invoked. So this file is safe whether or not SES secrets are configured.
 *
 * The real happy-path send is intentionally NOT exercised end-to-end; doing so
 * would email real waitlist subscribers.
 */

test.skip(!ADMIN_PASSWORD, "ADMIN_PASSWORD is not set — the dashboard is disabled.");

test.beforeEach(async ({ page }) => {
	await login(page);
});

/** Statuses that prove "did not send": validation, missing creds, missing template. */
const NO_SEND = [404, 422, 500];

test.describe("POST /api/email/test", () => {
	test("rejects a missing template_id (422)", async ({ page }) => {
		const res = await page.request.post("/api/email/test", {
			data: { to: "someone@example.com" },
		});
		expect(res.status()).toBe(422);
	});

	test("rejects an invalid recipient address (422)", async ({ page }) => {
		const res = await page.request.post("/api/email/test", {
			data: { template_id: "tpl-welcome", to: "not-an-email" },
		});
		expect(res.status()).toBe(422);
		expect((await res.json()).error).toContain("valid email");
	});

	test("a well-formed request with an unknown template never sends", async ({ page }) => {
		const res = await page.request.post("/api/email/test", {
			data: { template_id: "tpl-nope", to: "someone@example.com" },
		});
		expect(NO_SEND).toContain(res.status());
		expect((await res.json()).ok).toBe(false);
	});
});

test.describe("POST /api/email/send", () => {
	test("rejects a missing template_id (422)", async ({ page }) => {
		const res = await page.request.post("/api/email/send", { data: { audience: "all" } });
		expect(res.status()).toBe(422);
	});

	test("rejects a request with neither subscriber_ids nor audience (422)", async ({ page }) => {
		const res = await page.request.post("/api/email/send", { data: { template_id: "tpl-welcome" } });
		expect(res.status()).toBe(422);
		expect((await res.json()).error).toContain("Provide subscriber_ids or an audience.");
	});

	test("rejects an unknown audience value (422)", async ({ page }) => {
		const res = await page.request.post("/api/email/send", {
			data: { template_id: "tpl-welcome", audience: "everyone" },
		});
		expect(res.status()).toBe(422);
	});

	test("a well-formed campaign with an unknown template never sends", async ({ page }) => {
		const res = await page.request.post("/api/email/send", {
			data: { template_id: "tpl-nope", audience: "all" },
		});
		expect(NO_SEND).toContain(res.status());
		expect((await res.json()).ok).toBe(false);
	});
});

test.describe("POST /api/email/schedule", () => {
	test("rejects a create with a non-positive scheduled_at (422)", async ({ page }) => {
		const res = await page.request.post("/api/email/schedule", {
			data: {
				action: "create",
				template_id: "tpl-welcome",
				audience: "all",
				scheduled_at: -1,
			},
		});
		expect(res.status()).toBe(422);
	});

	test("rejects a create with a missing audience (422)", async ({ page }) => {
		const res = await page.request.post("/api/email/schedule", {
			data: { action: "create", template_id: "tpl-welcome", scheduled_at: Date.now() + 3_600_000 },
		});
		expect(res.status()).toBe(422);
	});

	test("cancelling a non-existent campaign returns 404", async ({ page }) => {
		const res = await page.request.post("/api/email/schedule", {
			data: { action: "cancel", id: "cmp-does-not-exist" },
		});
		expect(res.status()).toBe(404);
	});
});

test.describe("dashboard", () => {
	test("the send button is disabled when SES is not configured", async ({ page }) => {
		// The test env has no AWS secrets, so `sesConfigured` is false and the
		// dashboard renders the campaign button disabled — a real send is
		// impossible from the UI here.
		await expect(page.locator("#send-btn")).toBeDisabled();
	});
});
