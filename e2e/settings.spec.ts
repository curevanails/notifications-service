import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, login } from "./helpers";

/**
 * The Settings page (`/settings`) that manages the recruit-alert recipient, and
 * the Recruit alerts list (`/recruit-alerts`). Both are auth-gated and read/write
 * the shared `app_settings` / `recruit_notifications` D1 tables. Saves go through
 * the Worker's own connection (no external wrangler), so they're lock-safe here.
 */

test.skip(!ADMIN_PASSWORD, "ADMIN_PASSWORD is not set — the dashboard is disabled.");

// Every test here reads/writes the single global `app_settings.recruit_notify_to`
// row, so running them in parallel (the local default; CI already pins workers:1)
// lets one test's save clobber another's between write and read. Force serial.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
	await login(page);
});

test.afterAll(async ({ browser }) => {
	// Reset the recipient so a local run doesn't leave alerts pointed somewhere.
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await login(page);
	await page.goto("/settings");
	await page.fill("#recruit_notify_to", "");
	await page.click('button[type="submit"]');
	await ctx.close();
});

test.describe("settings", () => {
	test("renders the recruit-alerts recipient field", async ({ page }) => {
		await page.goto("/settings");
		await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
		await expect(page.locator("#recruit_notify_to")).toBeVisible();
	});

	test("saving a recipient persists across a reload", async ({ page }) => {
		await page.goto("/settings");
		await page.fill("#recruit_notify_to", "zz-e2e-notify@example.com");
		await page.click('button[type="submit"]');

		await expect(page.getByText(/Saved\./)).toBeVisible();
		await page.reload();
		await expect(page.locator("#recruit_notify_to")).toHaveValue("zz-e2e-notify@example.com");
	});

	test("normalises multiple addresses and reports the count", async ({ page }) => {
		await page.goto("/settings");
		await page.fill("#recruit_notify_to", "a@example.com,  b@example.com");
		await page.click('button[type="submit"]');

		await expect(page.getByText("2 recipients will be notified.")).toBeVisible();
		await expect(page.locator("#recruit_notify_to")).toHaveValue("a@example.com, b@example.com");
	});

	test("rejects an invalid address", async ({ page }) => {
		await page.goto("/settings");
		await page.fill("#recruit_notify_to", "not-an-email");
		await page.click('button[type="submit"]');

		await expect(page.getByText(/look invalid/)).toBeVisible();
	});

	test("blank turns alerts off", async ({ page }) => {
		await page.goto("/settings");
		await page.fill("#recruit_notify_to", "");
		await page.click('button[type="submit"]');
		await expect(page.getByText(/alerts are now OFF/i)).toBeVisible();
	});
});

test.describe("recruit alerts list", () => {
	test("renders the alerts page", async ({ page }) => {
		await page.goto("/recruit-alerts");
		await expect(page.getByRole("heading", { name: "Recruit alerts" })).toBeVisible();
		// Either the empty state or a table — both are valid depending on data.
		const hasTable = await page.locator("table").count();
		const hasEmpty = await page.getByText(/No alerts yet/).count();
		expect(hasTable + hasEmpty).toBeGreaterThan(0);
	});

	test("reflects the configured recipient banner", async ({ page }) => {
		// Set a recipient, then the alerts page should name it.
		await page.goto("/settings");
		await page.fill("#recruit_notify_to", "banner-check@example.com");
		await page.click('button[type="submit"]');

		await page.goto("/recruit-alerts");
		await expect(page.getByText("banner-check@example.com")).toBeVisible();
	});
});
