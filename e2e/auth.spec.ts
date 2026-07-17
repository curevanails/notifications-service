import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, login } from "./helpers";

/**
 * The auth gate (src/middleware.ts). The dashboard can trigger real sends and
 * exposes subscriber data, so `/` and every `/api/email/*` action require a
 * valid signed session cookie. Public: `/login`, `/logout`, `/unsubscribe/*`,
 * and the `/api/webhooks/*` SNS receiver.
 */

test.skip(
	!ADMIN_PASSWORD,
	"ADMIN_PASSWORD is not set (.dev.vars or env) — the dashboard is disabled.",
);

test.describe("gate — protected surfaces", () => {
	test("unauthenticated / redirects to the login form", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	});

	test("the login page is not indexable", async ({ page }) => {
		await page.goto("/login");
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
			"content",
			"noindex, nofollow",
		);
	});

	for (const path of [
		"/api/email/send",
		"/api/email/test",
		"/api/email/templates",
		"/api/email/schedule",
	]) {
		test(`unauthenticated POST ${path} is redirected, not executed`, async ({ request }) => {
			const res = await request.post(path, { data: {}, maxRedirects: 0 });
			expect(res.status()).toBe(302);
			expect(res.headers().location).toBe("/login");
		});
	}

	for (const path of ["/settings", "/recruit-alerts"]) {
		test(`unauthenticated ${path} redirects to the login form`, async ({ request }) => {
			const res = await request.get(path, { maxRedirects: 0 });
			expect(res.status()).toBe(302);
			expect(res.headers().location).toBe("/login");
		});
	}
});

test.describe("gate — public surfaces stay reachable", () => {
	test("the SNS webhook is not behind the gate", async ({ request }) => {
		// Garbage body → 400 from the handler itself, NOT a 302 to /login.
		const res = await request.post("/api/webhooks/ses", {
			data: "not json",
			headers: { "content-type": "text/plain" },
			maxRedirects: 0,
		});
		expect(res.status()).not.toBe(302);
		expect(res.status()).toBe(400);
	});

	test("the unsubscribe page is not behind the gate", async ({ request }) => {
		const res = await request.get("/unsubscribe/bogus-token", { maxRedirects: 0 });
		expect(res.status()).toBe(200);
	});
});

test.describe("credentials", () => {
	test("wrong credentials are rejected and stay on the login form", async ({ page }) => {
		await page.goto("/login");
		await page.fill('input[name="username"]', ADMIN_USERNAME);
		await page.fill('input[name="password"]', "definitely-not-the-password");
		await page.click('button[type="submit"]');

		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByText("Incorrect username or password.")).toBeVisible();
	});

	test("a forged session cookie is rejected", async ({ page, context }) => {
		await page.goto("/login");
		await context.addCookies([
			{
				name: "cureva_admin_session",
				value: `${Date.now() + 86_400_000}.not-a-real-signature`,
				url: page.url(),
			},
		]);
		await page.goto("/");
		await expect(page).toHaveURL(/\/login$/);
	});

	test("valid credentials sign in; logout ends the session", async ({ page }) => {
		await login(page);
		await expect(page).toHaveURL(/\/$/);
		await expect(page.locator("h1", { hasText: "Email dashboard" })).toBeVisible();

		await page.goto("/logout");
		await page.goto("/");
		await expect(page).toHaveURL(/\/login$/);
	});
});
