import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Shared helpers for the notifications-service E2E suite.
 *
 * Auth mirrors the main site: a form login (`/login`) that issues a signed
 * session cookie, verified by `src/middleware.ts` on `/` and `/api/email/*`.
 */

/** Prefix on every template/row a test creates, so teardown can find them. */
export const E2E_PREFIX = "zz-e2e";

/**
 * Read a key from `.dev.vars` (which Miniflare loads into the previewed Worker)
 * or `process.env` (so CI can inject the same values). `process.env` wins.
 * Returns undefined when neither is set.
 */
export function devVar(name: string): string | undefined {
	if (process.env[name]) return process.env[name];
	try {
		const raw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq === -1) continue;
			if (t.slice(0, eq).trim() !== name) continue;
			return t
				.slice(eq + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
		}
	} catch {
		// No .dev.vars (e.g. CI without the file) — caller decides whether to skip.
	}
	return undefined;
}

export const ADMIN_USERNAME = devVar("ADMIN_USERNAME") || "admin";
export const ADMIN_PASSWORD = devVar("ADMIN_PASSWORD");

/** Sign in through the real login form and land on the dashboard. */
export async function login(page: Page): Promise<void> {
	await page.goto("/login");
	await page.fill('input[name="username"]', ADMIN_USERNAME);
	await page.fill('input[name="password"]', ADMIN_PASSWORD as string);
	await Promise.all([
		page.waitForURL((url) => new URL(url).pathname === "/"),
		page.click('button[type="submit"]'),
	]);
}

/** A unique template name so parallel workers never collide. */
export function uniqueTemplateName(): string {
	return `${E2E_PREFIX} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
