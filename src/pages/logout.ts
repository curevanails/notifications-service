import type { APIRoute } from "astro";
import { SESSION_COOKIE } from "../utils/admin-auth";

// Server-rendered endpoint — never prerender.
export const prerender = false;

/** Clears the admin session cookie and returns to the login form. */
export const GET: APIRoute = ({ cookies, redirect }) => {
	cookies.delete(SESSION_COOKIE, { path: "/" });
	return redirect("/login", 302);
};
