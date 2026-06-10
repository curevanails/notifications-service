import Handlebars from "handlebars";

/**
 * Handlebars rendering for email templates.
 *
 * Variables are case-sensitive (`{{name}}`, `{{discount_code}}`,
 * `{{unsubscribe_url}}`). Subject is rendered with HTML-escaping disabled
 * (it's plain text), the HTML body with escaping on (the default) so injected
 * variable values can't break out of the markup.
 */

export interface TemplateInput {
	subject: string;
	html: string;
	text?: string | null;
}

export interface RenderedEmail {
	subject: string;
	html: string;
	text?: string;
}

export function renderTemplate(
	tpl: TemplateInput,
	variables: Record<string, unknown>,
): RenderedEmail {
	const subject = Handlebars.compile(tpl.subject, { noEscape: true })(variables);
	const html = Handlebars.compile(tpl.html)(variables);
	const text = tpl.text
		? Handlebars.compile(tpl.text, { noEscape: true })(variables)
		: undefined;
	return { subject, html, text };
}

/**
 * The public opt-out URL for a subscriber's token. `baseUrl` is the public
 * origin of the site that hosts the unsubscribe page (no trailing slash).
 */
export function buildUnsubscribeUrl(baseUrl: string, token: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/unsubscribe/${encodeURIComponent(token)}`;
}
