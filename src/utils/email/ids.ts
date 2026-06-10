import { nanoid } from "nanoid";

/** Primary-key id for email rows (logs, etc.). URL-safe, 21 chars. */
export function newId(): string {
	return nanoid();
}
