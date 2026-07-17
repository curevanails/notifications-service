import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the CureVà notifications-service.
 *
 * Tests run against the *built* Cloudflare Worker via `astro preview`
 * (Miniflare), so they exercise the real endpoints with live local D1 + KV
 * bindings — not the dev server (whose vite dep-optimizer can 500 mid-warmup).
 * The `webServer` block builds then previews on PORT.
 *
 * The dashboard and `/api/email/*` are auth-gated: with no `ADMIN_PASSWORD` the
 * whole area returns 404, so the suite needs one set. Miniflare loads it from
 * `.dev.vars`; CI writes a `.dev.vars` before the run (see .github/workflows).
 *
 * SES credentials are deliberately NOT provided in the test env — the send /
 * test / schedule endpoints check for them before contacting AWS, so no test
 * can ever dispatch a real email.
 */
const PORT = Number(process.env.E2E_PORT ?? 8788);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	globalTeardown: "./e2e/global-teardown.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI
		? [["github"], ["html", { open: "never" }]]
		: "list",
	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		// `reuseExistingServer` (local only) lets you point at an already-running
		// `pnpm preview --port 8788` to skip the rebuild while iterating.
		command: `pnpm build && pnpm preview --port ${PORT}`,
		url: `${BASE_URL}/login`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
