import handler from "@astrojs/cloudflare/entrypoints/server";
import { runDueCampaigns } from "./utils/email/campaigns";

// The Astro Cloudflare adapter provides the `fetch` handler. We extend it with
// a `scheduled` handler so the Cron Trigger (see wrangler.jsonc) can fire due
// scheduled campaigns. `ctx.waitUntil` keeps the Worker alive until sending
// finishes.
const base = handler as ExportedHandler;

export default {
	fetch: base.fetch,
	scheduled(_controller, _env, ctx) {
		ctx.waitUntil(runDueCampaigns());
	},
} satisfies ExportedHandler;
