import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

// Standalone notifications service. All pages/endpoints are server-rendered on
// Cloudflare Workers; the D1 binding (`DB`) and AWS SES secrets are configured
// in wrangler.jsonc / Worker secrets — see docs/EMAIL.md.
export default defineConfig({
	output: "server",
	adapter: cloudflare({ configPath: process.env.WRANGLER_CONFIG }),
	devToolbar: { enabled: false },
});
