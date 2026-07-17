import { type APIRequestContext, expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, login, uniqueTemplateName } from "./helpers";

/**
 * Template CRUD via `POST /api/email/templates` and the dashboard that renders
 * the list. This endpoint only touches D1 — no AWS SES — so it is exercised
 * fully, including the real create → update → delete lifecycle. Rows carry the
 * `zz-e2e` name prefix and are removed here (and, as a safety net, by
 * global-teardown).
 *
 * Auth: the endpoint is gated, so every request is made from a signed-in
 * browser context (`page.request` carries the session cookie).
 */

test.skip(!ADMIN_PASSWORD, "ADMIN_PASSWORD is not set — the dashboard is disabled.");

test.beforeEach(async ({ page }) => {
	await login(page);
});

/** POST helper bound to the authenticated page context. */
function post(api: APIRequestContext, body: unknown) {
	return api.post("/api/email/templates", { data: body });
}

test.describe("validation", () => {
	test("rejects an unknown action", async ({ page }) => {
		const res = await post(page.request, { action: "frobnicate" });
		expect(res.status()).toBe(422);
		expect((await res.json()).ok).toBe(false);
	});

	test("rejects a create with a blank name", async ({ page }) => {
		const res = await post(page.request, {
			action: "create",
			name: "",
			subject: "Hi",
			html: "<p>Hi</p>",
		});
		expect(res.status()).toBe(422);
		expect((await res.json()).error).toContain("Name is required.");
	});

	test("rejects a create with a blank subject", async ({ page }) => {
		const res = await post(page.request, {
			action: "create",
			name: uniqueTemplateName(),
			subject: "",
			html: "<p>Hi</p>",
		});
		expect(res.status()).toBe(422);
		expect((await res.json()).error).toContain("Subject is required.");
	});

	test("rejects a create with an empty HTML body", async ({ page }) => {
		const res = await post(page.request, {
			action: "create",
			name: uniqueTemplateName(),
			subject: "Hi",
			html: "",
		});
		expect(res.status()).toBe(422);
		expect((await res.json()).error).toContain("HTML body is required.");
	});

	test("update and delete of a missing id return 404", async ({ page }) => {
		const upd = await post(page.request, {
			action: "update",
			id: "tpl-does-not-exist",
			name: uniqueTemplateName(),
			subject: "Hi",
			html: "<p>Hi</p>",
		});
		expect(upd.status()).toBe(404);

		const del = await post(page.request, { action: "delete", id: "tpl-does-not-exist" });
		expect(del.status()).toBe(404);
	});
});

test.describe("lifecycle (real D1)", () => {
	test("create → update → delete round-trips and the list stays consistent", async ({ page }) => {
		const name = uniqueTemplateName();

		// Create — extracts {{name}} and {{discount_code}} into variables.
		const created = await post(page.request, {
			action: "create",
			name,
			subject: "Welcome {{name}}",
			html: "<p>Your code is {{discount_code}}</p>",
		});
		expect(created.status()).toBe(200);
		const createdBody = await created.json();
		expect(createdBody.ok).toBe(true);
		expect(createdBody.id).toMatch(/^tpl-/);
		expect(createdBody.templates.some((t: { id: string }) => t.id === createdBody.id)).toBe(true);
		const id: string = createdBody.id;

		try {
			// Update — new subject/body is reflected in the returned list.
			const newName = uniqueTemplateName();
			const updated = await post(page.request, {
				action: "update",
				id,
				name: newName,
				subject: "Updated subject",
				html: "<p>Updated body</p>",
			});
			expect(updated.status()).toBe(200);
			const updatedRow = (await updated.json()).templates.find(
				(t: { id: string }) => t.id === id,
			);
			expect(updatedRow.name).toBe(newName);
			expect(updatedRow.subject).toBe("Updated subject");

			// Delete — id disappears from the list.
			const deleted = await post(page.request, { action: "delete", id });
			expect(deleted.status()).toBe(200);
			const stillThere = (await deleted.json()).templates.some(
				(t: { id: string }) => t.id === id,
			);
			expect(stillThere).toBe(false);
		} finally {
			// Ensure cleanup even if an assertion above failed before the delete.
			await post(page.request, { action: "delete", id }).catch(() => {});
		}
	});

	test("a newly created template appears in the dashboard compose dropdown", async ({ page }) => {
		const name = uniqueTemplateName();
		const created = await post(page.request, {
			action: "create",
			name,
			subject: "Dropdown check",
			html: "<p>Hello</p>",
		});
		const id = (await created.json()).id as string;

		try {
			await page.reload();
			await expect(page.locator(`#template option[value="${id}"]`)).toHaveText(name);
		} finally {
			await post(page.request, { action: "delete", id }).catch(() => {});
		}
	});
});
