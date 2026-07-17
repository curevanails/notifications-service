import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro:middleware";
import { SESSION_COOKIE, verifySessionToken } from "./utils/admin-auth";

/**
 * Auth gate for the dashboard.
 *
 * The dashboard at `/` can trigger real sends and exposes subscriber data, so
 * it — and the `/api/email/*` action endpoints behind it — require a valid
 * signed session cookie. Public routes: `/login`, `/logout`, the public
 * `/unsubscribe/*` opt-out page, and the `/api/webhooks/*` SNS receiver.
 *
 * Credentials come from secrets (`wrangler secret put`):
 *   ADMIN_PASSWORD  (required — if unset, the dashboard returns 404 and is
 *                    effectively disabled)
 *   ADMIN_USERNAME  (optional — defaults to "admin")
 *
 * Note: Astro v6 removed `Astro.locals.runtime.env`; read Worker vars via the
 * `cloudflare:workers` module. Reading the env can throw in some adapter paths,
 * so every access is wrapped — a throw here must never 500 the request.
 */
function workerVar(name: string): string | undefined {
	try {
		return (env as unknown as Record<string, string | undefined>)[name];
	} catch {
		return undefined;
	}
}

/** Paths that require a valid session: the dashboard and its action endpoints. */
function isProtected(path: string): boolean {
	return (
		path === "/" ||
		path === "/settings" ||
		path === "/recruit-alerts" ||
		path.startsWith("/api/email/") ||
		path.startsWith("/api/settings")
	);
}

export const onRequest = defineMiddleware(async (context, next) => {
	const path = context.url.pathname;

	// Everything not explicitly protected (login, logout, unsubscribe, the SNS
	// webhook, static assets, 404s) passes straight through.
	if (!isProtected(path)) return next();

	const password = workerVar("ADMIN_PASSWORD");
	// No password configured → pretend the dashboard doesn't exist.
	if (!password) {
		return new Response("Not found", { status: 404 });
	}

	const token = context.cookies.get(SESSION_COOKIE)?.value;
	if (!(await verifySessionToken(token, password))) {
		return context.redirect("/login", 302);
	}

	return next();
});
