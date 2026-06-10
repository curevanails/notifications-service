/**
 * Session helpers for the recruit admin area.
 *
 * Auth is form-based (see src/pages/login.astro) rather than HTTP Basic
 * Auth, so we issue a stateless, signed session token instead of re-prompting
 * for credentials on every request. The token is an HMAC-SHA256 signature of
 * its own expiry timestamp, keyed by the `ADMIN_PASSWORD` secret — so it needs
 * no server-side storage, and rotating the password instantly invalidates every
 * outstanding session.
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE = "cureva_admin_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function bufToBase64Url(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
	return bufToBase64Url(sig);
}

/** Length-safe string comparison to avoid leaking via timing. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

/** Validate submitted login credentials. */
export function verifyCredentials(
	user: string,
	pass: string,
	expectedUser: string,
	expectedPass: string,
): boolean {
	// Evaluate both so a wrong username doesn't return faster than a wrong password.
	const userOk = safeEqual(user, expectedUser);
	const passOk = safeEqual(pass, expectedPass);
	return userOk && passOk;
}

/** Mint a signed session token valid for SESSION_TTL_MS. */
export async function createSessionToken(
	secret: string,
	now = Date.now(),
): Promise<string> {
	const expiry = now + SESSION_TTL_MS;
	const sig = await sign(secret, String(expiry));
	return `${expiry}.${sig}`;
}

/** True when `token` is a non-expired, correctly-signed session token. */
export async function verifySessionToken(
	token: string | undefined,
	secret: string,
	now = Date.now(),
): Promise<boolean> {
	if (!token) return false;
	const dot = token.indexOf(".");
	if (dot === -1) return false;
	const expiryStr = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expiry = Number(expiryStr);
	if (!Number.isFinite(expiry) || expiry < now) return false;
	const expected = await sign(secret, expiryStr);
	return safeEqual(sig, expected);
}
