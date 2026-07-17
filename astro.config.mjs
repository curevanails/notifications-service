import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

// Standalone notifications service. All pages/endpoints are server-rendered on
// Cloudflare Workers; the D1 binding (`DB`) and AWS SES secrets are configured
// in wrangler.jsonc / Worker secrets — see docs/EMAIL.md.
export default defineConfig({
	output: "server",
	adapter: cloudflare({ configPath: process.env.WRANGLER_CONFIG }),
	devToolbar: { enabled: false },
	// AWS SNS posts to /api/webhooks/ses with `Content-Type: text/plain` and no
	// `Origin` header. Astro's default CSRF `checkOrigin` rejects exactly that
	// shape with a 403 *before* the handler runs, which would drop every SES
	// delivery/bounce/complaint event. We turn it off and rely on stronger,
	// intentional protection instead: the signed-cookie auth gate
	// (src/middleware.ts) on the dashboard + `/api/email/*`, SNS signature
	// verification on the webhook, and the unguessable token on /unsubscribe.
	security: { checkOrigin: false },
});
