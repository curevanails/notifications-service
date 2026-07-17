import { expect, test } from "@playwright/test";

/**
 * The public, token-gated opt-out page (`/unsubscribe/[token]`). No auth — the
 * unguessable token is the credential.
 *
 * These tests exercise the public-reachability and unknown-token branches,
 * which need no seeded data. The DB-mutating happy path (a valid token →
 * "You're unsubscribed") is intentionally not driven here: seeding a `waitlist`
 * row via a separate `wrangler d1` process while the preview Worker holds the
 * local SQLite file open races on the DB lock. If that path needs coverage,
 * seed through a fixture that shares the Worker's own connection (e.g. a
 * test-only endpoint) rather than an external process.
 */

test("an unknown token shows the 'not recognized' state, publicly", async ({ page }) => {
	const res = await page.goto("/unsubscribe/definitely-not-a-real-token");
	// 200, not a 302 to /login — the page is outside the auth gate.
	expect(res?.status()).toBe(200);
	await expect(page.getByRole("heading", { name: "Link not recognized" })).toBeVisible();
});

test("the unsubscribe page is not indexable", async ({ page }) => {
	await page.goto("/unsubscribe/any-token");
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
		"content",
		"noindex, nofollow",
	);
});

test("the unsubscribe route is reachable without a session cookie", async ({ request }) => {
	const res = await request.get("/unsubscribe/some-token", { maxRedirects: 0 });
	expect(res.status()).toBe(200);
});

test("accepts the RFC 8058 one-click POST (not CSRF-blocked, not 405)", async ({ request }) => {
	// Gmail/Yahoo POST here with this exact body and no cookies/Origin. It must
	// reach the handler (200), never a 403 CSRF block or a 405. A bogus token
	// renders the invalid state but still returns 200 — that's the contract.
	const res = await request.post("/unsubscribe/one-click-probe-token", {
		form: { "List-Unsubscribe": "One-Click" },
		maxRedirects: 0,
	});
	expect(res.status()).toBe(200);
});
