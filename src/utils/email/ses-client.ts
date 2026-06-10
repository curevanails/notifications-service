import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { isSuppressed } from "./suppression";

/**
 * AWS SES (v2) sending. Region + credentials come from Worker secrets — never
 * hardcoded. The From address and Configuration Set are fixed to the verified
 * CureVà identity.
 */

export const FROM_ADDRESS = "CureVà <hello@cureva.vn>";
export const CONFIGURATION_SET = "cureva-main";

export interface SesCredentials {
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/** Pull SES credentials from the Worker env, throwing if anything is missing. */
export function sesCredentialsFromEnv(env: Record<string, unknown>): SesCredentials {
	const region = typeof env.AWS_REGION === "string" ? env.AWS_REGION : "";
	const accessKeyId =
		typeof env.AWS_ACCESS_KEY_ID === "string" ? env.AWS_ACCESS_KEY_ID : "";
	const secretAccessKey =
		typeof env.AWS_SECRET_ACCESS_KEY === "string" ? env.AWS_SECRET_ACCESS_KEY : "";
	if (!region || !accessKeyId || !secretAccessKey) {
		throw new Error(
			"SES credentials missing: set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.",
		);
	}
	return { region, accessKeyId, secretAccessKey };
}

export function createSesClient(creds: SesCredentials): SESv2Client {
	return new SESv2Client({
		region: creds.region,
		credentials: {
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
		},
	});
}

export interface SendParams {
	to: string;
	subject: string;
	html: string;
	text?: string;
	/** email_logs.id, surfaced to SES events via the `log_id` tag. */
	logId: string;
}

/**
 * Send one already-rendered email. Performs the mandatory pre-send suppression
 * check against the DB, then dispatches via SES. Returns the SES MessageId.
 */
export async function sendEmail(
	client: SESv2Client,
	db: D1Database,
	params: SendParams,
): Promise<string | undefined> {
	if (await isSuppressed(db, params.to)) {
		throw new Error(`Email suppressed: ${params.to}`);
	}

	const result = await client.send(
		new SendEmailCommand({
			FromEmailAddress: FROM_ADDRESS,
			Destination: { ToAddresses: [params.to] },
			Content: {
				Simple: {
					Subject: { Data: params.subject },
					Body: {
						Html: { Data: params.html },
						...(params.text ? { Text: { Data: params.text } } : {}),
					},
				},
			},
			ConfigurationSetName: CONFIGURATION_SET,
			EmailTags: [{ Name: "log_id", Value: params.logId }],
		}),
	);

	return result.MessageId;
}
