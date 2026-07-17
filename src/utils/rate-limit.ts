/**
 * Lightweight KV-backed rate limiter.
 *
 * Uses the `SESSION` KV namespace (bound for the Astro adapter) as a
 * fixed-window counter keyed by client IP. Used to blunt brute-force attempts
 * against the admin login. If KV is unavailable the limiter fails open (returns
 * allowed) so a KV hiccup never locks a legitimate admin out entirely.
 *
 * Note: KV's minimum TTL is 60s, so `windowSec` must be ≥ 60.
 */

export interface RateLimitResult {
	ok: boolean;
	remaining: number;
}

export async function rateLimit(
	kv: KVNamespace | undefined,
	key: string,
	limit: number,
	windowSec: number,
): Promise<RateLimitResult> {
	if (!kv) return { ok: true, remaining: limit };

	const k = `rl:${key}`;
	const now = Date.now();

	try {
		const cur = (await kv.get(k, "json")) as { c: number; reset: number } | null;

		if (!cur || cur.reset < now) {
			await kv.put(k, JSON.stringify({ c: 1, reset: now + windowSec * 1000 }), {
				expirationTtl: windowSec,
			});
			return { ok: true, remaining: limit - 1 };
		}

		if (cur.c >= limit) return { ok: false, remaining: 0 };

		const ttl = Math.max(60, Math.ceil((cur.reset - now) / 1000));
		await kv.put(k, JSON.stringify({ c: cur.c + 1, reset: cur.reset }), {
			expirationTtl: ttl,
		});
		return { ok: true, remaining: limit - cur.c - 1 };
	} catch {
		return { ok: true, remaining: limit };
	}
}

/**
 * Read-only check: true when `key` has already reached `limit` failures in the
 * current window. Does NOT mutate the counter — pair with `recordAttempt` so a
 * successful login never counts against the limit (only failures are
 * throttled, and a legitimate admin is never locked out by their own success).
 * Fails open on KV errors.
 */
export async function isRateLimited(
	kv: KVNamespace | undefined,
	key: string,
	limit: number,
): Promise<boolean> {
	if (!kv) return false;
	try {
		const cur = (await kv.get(`rl:${key}`, "json")) as
			| { c: number; reset: number }
			| null;
		if (!cur || cur.reset < Date.now()) return false;
		return cur.c >= limit;
	} catch {
		return false;
	}
}

/** Increment the fixed-window counter for `key`. Call on each failed attempt. */
export async function recordAttempt(
	kv: KVNamespace | undefined,
	key: string,
	windowSec: number,
): Promise<void> {
	if (!kv) return;
	const k = `rl:${key}`;
	const now = Date.now();
	try {
		const cur = (await kv.get(k, "json")) as { c: number; reset: number } | null;
		if (!cur || cur.reset < now) {
			await kv.put(k, JSON.stringify({ c: 1, reset: now + windowSec * 1000 }), {
				expirationTtl: windowSec,
			});
		} else {
			const ttl = Math.max(60, Math.ceil((cur.reset - now) / 1000));
			await kv.put(k, JSON.stringify({ c: cur.c + 1, reset: cur.reset }), {
				expirationTtl: ttl,
			});
		}
	} catch {
		// best-effort — never block a login on a KV hiccup
	}
}
