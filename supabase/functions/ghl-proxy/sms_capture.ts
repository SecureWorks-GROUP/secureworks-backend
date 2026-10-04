// send_sms evidence (context slice C1a, design sms.md §3 review M9).
//
// A text our tools send is saved exactly once, through the shared row builder
// (_shared/evidence/ghl_message.ts) and the one SQL writer
// public.capture_business_event. If GHL's OutboundMessage webhook saved the same
// message first, the writer answers "duplicate" and, when this send carries a
// verified job, upgrades that row's link to the job (the upgrade rule). A
// duplicate is a saved row, never a failure. There is no second write path.

import {
  buildGhlMessageRow,
  type GhlMessageBuild,
  type RecipientRole,
} from "../_shared/evidence/ghl_message.ts";

export const SEND_SMS_EVIDENCE_SOURCE = "ghl-proxy";

/** What the job row says about the job named on a send. Null when it could not be read. */
export interface SendSmsJobRead {
  ghl_contact_id?: string | null;
}

/**
 * A named job is verified only when the job row was read and its GHL contact is
 * the contact the text went to. A job we could not read, or a job with no
 * contact, is kept as a hint for the ladder, never as a direct link.
 */
export function sendSmsJobCustody(
  jobId: string | null | undefined,
  job: SendSmsJobRead | null | undefined,
  contactId: string,
): {
  verifiedJobId: string | null;
  unverifiedJobId: string | null;
} {
  const named = typeof jobId === "string" && jobId.trim() ? jobId.trim() : null;
  if (!named) return { verifiedJobId: null, unverifiedJobId: null };
  if (
    job && typeof job.ghl_contact_id === "string" &&
    job.ghl_contact_id === contactId
  ) {
    return { verifiedJobId: named, unverifiedJobId: null };
  }
  return { verifiedJobId: null, unverifiedJobId: named };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A send_sms caller says a text goes to crew or staff (recipientRole) and,
 * optionally, which job it is about (aboutJobId). Such a text is never linked
 * to a job: jobId is the customer-job link (checked against the job's contact)
 * and is refused beside recipientRole, and aboutJobId is refused without it.
 */
export function parseSendSmsRecipient(
  body: { recipientRole?: unknown; aboutJobId?: unknown; jobId?: unknown },
):
  | { ok: true; recipientRole: RecipientRole | null; aboutJobId: string | null }
  | { ok: false; error: string } {
  const role = body.recipientRole;
  const about = body.aboutJobId;
  if (role === undefined || role === null || role === "") {
    if (about !== undefined && about !== null && about !== "") {
      return {
        ok: false,
        error: "aboutJobId needs recipientRole crew or staff",
      };
    }
    return { ok: true, recipientRole: null, aboutJobId: null };
  }
  if (role !== "crew" && role !== "staff") {
    return { ok: false, error: "recipientRole must be crew or staff" };
  }
  if (body.jobId !== undefined && body.jobId !== null && body.jobId !== "") {
    return {
      ok: false,
      error: "a text to crew or staff names its job as aboutJobId, never jobId",
    };
  }
  if (about === undefined || about === null || about === "") {
    return { ok: true, recipientRole: role, aboutJobId: null };
  }
  if (typeof about !== "string" || !UUID.test(about.trim().toLowerCase())) {
    return { ok: false, error: "aboutJobId must be a job id" };
  }
  return {
    ok: true,
    recipientRole: role,
    aboutJobId: about.trim().toLowerCase(),
  };
}

export interface SendSmsEvidenceInput {
  contactId: string;
  message: string;
  fromNumber: string;
  jobId?: string | null;
  job?: SendSmsJobRead | null;
  /** GHL's response to POST /conversations/messages. */
  // deno-lint-ignore no-explicit-any
  result: Record<string, any>;
  bodyHash?: string | null;
  /** The text went to crew or staff, not a customer (parseSendSmsRecipient). */
  recipientRole?: RecipientRole | null;
  aboutJobId?: string | null;
}

/** The row for a text our tool just sent, built by the shared builder. */
export function buildSendSmsEvidenceRow(
  input: SendSmsEvidenceInput,
): GhlMessageBuild {
  const custody = input.recipientRole
    ? { verifiedJobId: null, unverifiedJobId: null }
    : sendSmsJobCustody(input.jobId, input.job, input.contactId);
  return buildGhlMessageRow({
    messageId: input.result?.messageId ?? input.result?.id ?? null,
    messageType: "SMS",
    direction: "outbound",
    body: input.message,
    dateAdded: input.result?.dateAdded ?? input.result?.createdAt ?? null,
    contactId: input.contactId,
    conversationId: input.result?.conversationId ?? null,
  }, {
    source: SEND_SMS_EVIDENCE_SOURCE,
    captureMode: "live",
    verifiedJobId: custody.verifiedJobId,
    unverifiedJobId: custody.unverifiedJobId,
    ourNumber: input.fromNumber,
    sentByKind: "our_tool",
    bodyHash: input.bodyHash ?? null,
    recipientRole: input.recipientRole ?? null,
    aboutJobId: input.aboutJobId ?? null,
  });
}

export type CaptureOutcome =
  | {
    outcome: "inserted";
    id: string;
    job_id: string | null;
    attribution_status: string | null;
  }
  | {
    outcome: "duplicate";
    id: string;
    job_id: string | null;
    attribution_status: string | null;
    upgraded: boolean;
  }
  | { outcome: "capture_disabled" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "error"; code: string };

/**
 * Save one send through capture_business_event. Never throws: the text has
 * already gone, so an evidence problem is reported, logged by code and id only,
 * and left for the reconciler to recover.
 */
export async function saveSendSmsEvidence(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: SendSmsEvidenceInput,
): Promise<CaptureOutcome> {
  let built: GhlMessageBuild;
  try {
    built = buildSendSmsEvidenceRow(input);
  } catch {
    return { outcome: "error", code: "row_build_failed" };
  }
  if (built.kind === "skip") {
    console.error(`[ghl-proxy] send_sms evidence not written: ${built.reason}`);
    return { outcome: "skipped", reason: built.reason };
  }
  try {
    const { data, error } = await client.rpc("capture_business_event", {
      p_row: built.row,
    });
    if (error) {
      console.error(
        `[ghl-proxy] send_sms evidence rpc failed: ${
          error.code ?? "unknown"
        } ${built.row.provider_message_id}`,
      );
      return { outcome: "error", code: String(error.code ?? "rpc_error") };
    }
    const outcome = data && typeof data === "object"
      ? data as CaptureOutcome
      : { outcome: "error" as const, code: "rpc_no_result" };
    if (outcome.outcome === "error") {
      console.error(
        `[ghl-proxy] send_sms evidence refused: ${outcome.code} ${built.row.provider_message_id}`,
      );
    }
    return outcome;
  } catch {
    console.error(
      `[ghl-proxy] send_sms evidence rpc threw ${built.row.provider_message_id}`,
    );
    return { outcome: "error", code: "rpc_threw" };
  }
}
