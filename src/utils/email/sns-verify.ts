/**
 * Amazon SNS message signature verification (no external deps, runs on
 * Workers via WebCrypto).
 *
 * SNS signs a canonical string built from specific message fields with the RSA
 * private key behind `SigningCertURL`. We:
 *   1. validate the cert URL is a genuine AWS SNS host,
 *   2. fetch the X.509 cert and extract its SubjectPublicKeyInfo (SPKI),
 *   3. rebuild the canonical string and verify the base64 `Signature`.
 *
 * SignatureVersion "1" → RSA/SHA-1, "2" → RSA/SHA-256.
 */

export interface SnsMessage {
	Type: string;
	MessageId?: string;
	Token?: string;
	TopicArn?: string;
	Subject?: string;
	Message?: string;
	Timestamp?: string;
	SubscribeURL?: string;
	Signature?: string;
	SignatureVersion?: string;
	SigningCertURL?: string;
	SigningCertUrl?: string; // some payloads use this casing
}

const certCache = new Map<string, CryptoKey>();

/**
 * True when `url` is an https URL on a genuine AWS SNS host
 * (`sns.<region>.amazonaws.com`). Used to validate both the signing-cert URL
 * and the one-time `SubscribeURL` we auto-confirm — never fetch a URL from an
 * SNS payload without passing it through this first.
 */
export function isValidSnsUrl(url: string | undefined): url is string {
	if (!url) return false;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	return (
		u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(u.hostname)
	);
}

function isValidCertUrl(url: string): boolean {
	return isValidSnsUrl(url) && new URL(url).pathname.endsWith(".pem");
}

/** The field set + order SNS uses to build the string-to-sign. */
function canonicalString(msg: SnsMessage): string | null {
	const fields =
		msg.Type === "Notification"
			? msg.Subject !== undefined
				? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
				: ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
			: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];

	let out = "";
	for (const key of fields) {
		const value = (msg as unknown as Record<string, unknown>)[key];
		if (typeof value !== "string") return null;
		out += `${key}\n${value}\n`;
	}
	return out;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64.replace(/\s+/g, ""));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function pemToDer(pem: string): Uint8Array {
	const body = pem
		.replace(/-----BEGIN CERTIFICATE-----/, "")
		.replace(/-----END CERTIFICATE-----/, "")
		.replace(/\s+/g, "");
	return base64ToBytes(body);
}

// --- Minimal DER walk to pull the SubjectPublicKeyInfo out of an X.509 cert ---

interface Tlv {
	contentStart: number;
	contentEnd: number;
	end: number;
}

/** Read one DER TLV starting at `offset`. */
function readTlv(buf: Uint8Array, offset: number): Tlv {
	// byte 0 = tag (we don't need its value), byte 1.. = length
	let i = offset + 1;
	let len = buf[i++];
	if (len & 0x80) {
		const n = len & 0x7f;
		len = 0;
		for (let k = 0; k < n; k++) len = (len << 8) | buf[i++];
	}
	const contentStart = i;
	return { contentStart, contentEnd: contentStart + len, end: contentStart + len };
}

/**
 * Extract the SPKI (DER of SubjectPublicKeyInfo) from an X.509 certificate.
 * Positional walk of TBSCertificate: [version?] serial, sigAlg, issuer,
 * validity, subject, **subjectPublicKeyInfo**.
 */
function extractSpki(certDer: Uint8Array): Uint8Array {
	const cert = readTlv(certDer, 0); // Certificate SEQUENCE
	const tbs = readTlv(certDer, cert.contentStart); // TBSCertificate SEQUENCE
	let p = tbs.contentStart;

	// Optional EXPLICIT [0] version has context tag 0xA0.
	if (certDer[p] === 0xa0) p = readTlv(certDer, p).end;

	// serialNumber, signature, issuer, validity, subject — skip 5 elements.
	for (let k = 0; k < 5; k++) p = readTlv(certDer, p).end;

	// subjectPublicKeyInfo — return the whole element (tag..content).
	const spki = readTlv(certDer, p);
	return certDer.slice(p, spki.end);
}

async function getPublicKey(
	certUrl: string,
	hash: "SHA-1" | "SHA-256",
): Promise<CryptoKey> {
	const cacheKey = `${certUrl}|${hash}`;
	const cached = certCache.get(cacheKey);
	if (cached) return cached;

	const res = await fetch(certUrl);
	if (!res.ok) throw new Error(`Failed to fetch SNS signing cert (${res.status})`);
	const pem = await res.text();
	const spki = extractSpki(pemToDer(pem));

	const key = await crypto.subtle.importKey(
		"spki",
		spki as unknown as ArrayBuffer,
		{ name: "RSASSA-PKCS1-v1_5", hash },
		false,
		["verify"],
	);
	certCache.set(cacheKey, key);
	return key;
}

/**
 * Verify an SNS message signature. Returns false for anything that fails
 * structural checks, an untrusted cert host, or a bad signature.
 */
export async function verifySnsMessage(msg: SnsMessage): Promise<boolean> {
	const certUrl = msg.SigningCertURL ?? msg.SigningCertUrl;
	if (!certUrl || !isValidCertUrl(certUrl)) return false;
	if (typeof msg.Signature !== "string") return false;

	const canonical = canonicalString(msg);
	if (canonical == null) return false;

	const hash = msg.SignatureVersion === "2" ? "SHA-256" : "SHA-1";

	try {
		const key = await getPublicKey(certUrl, hash);
		const signature = base64ToBytes(msg.Signature);
		const data = new TextEncoder().encode(canonical);
		return await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			signature as unknown as ArrayBuffer,
			data as unknown as ArrayBuffer,
		);
	} catch {
		return false;
	}
}
