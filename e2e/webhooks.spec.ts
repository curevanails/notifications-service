import { expect, test } from "@playwright/test";

/**
 * The public SNS → SES event receiver (`POST /api/webhooks/ses`). It is NOT
 * auth-gated (AWS posts to it directly), so its own defenses are the boundary:
 * malformed JSON is a 400, and every message must carry a signature that
 * verifies against a genuine AWS signing cert or it is rejected with 403.
 *
 * These tests confirm the endpoint rejects untrusted input; they never present
 * a valid signature (that would require AWS's private key), so no event is ever
 * folded into email_logs.
 */

test.describe("POST /api/webhooks/ses", () => {
	// Regression guard: AWS SNS posts as `text/plain` with no `Origin` header.
	// Astro's default CSRF `checkOrigin` would 403 that shape *before* the
	// handler runs (see astro.config.mjs `security.checkOrigin: false`). A `400
	// Bad request` here proves the request reached the handler's JSON.parse —
	// i.e. real SNS deliveries are not being CSRF-blocked.
	test("a text/plain non-JSON body reaches the handler and returns 400", async ({ request }) => {
		const res = await request.post("/api/webhooks/ses", {
			data: "definitely not json",
			headers: { "content-type": "text/plain" },
		});
		expect(res.status()).toBe(400);
		expect(await res.text()).toContain("Bad request"); // handler, not CSRF
	});

	test("rejects a well-formed message with no signature (403)", async ({ request }) => {
		const res = await request.post("/api/webhooks/ses", {
			data: {
				Type: "Notification",
				MessageId: "id-1",
				TopicArn: "arn:aws:sns:us-east-1:1:cureva",
				Message: "{}",
				Timestamp: "2026-01-01T00:00:00.000Z",
			},
		});
		expect(res.status()).toBe(403);
		expect(await res.text()).toContain("Invalid signature"); // signature check, not CSRF
	});

	test("rejects a forged signature / bogus signing cert URL (403)", async ({ request }) => {
		const res = await request.post("/api/webhooks/ses", {
			data: {
				Type: "SubscriptionConfirmation",
				MessageId: "id-2",
				Token: "tok",
				TopicArn: "arn:aws:sns:us-east-1:1:cureva",
				Message: "please confirm",
				SubscribeURL: "https://example.com/confirm",
				Timestamp: "2026-01-01T00:00:00.000Z",
				SignatureVersion: "1",
				Signature: "AAAA",
				SigningCertURL: "https://evil.example.com/cert.pem",
			},
		});
		expect(res.status()).toBe(403);
	});

	test("is publicly reachable (not redirected to login)", async ({ request }) => {
		const res = await request.post("/api/webhooks/ses", {
			data: "x",
			headers: { "content-type": "text/plain" },
			maxRedirects: 0,
		});
		expect(res.status()).not.toBe(302);
	});
});
