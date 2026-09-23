// send_sms evidence (context slice C1a, design sms.md §3 review M9).
//
// A text our tools send is saved exactly once, through the shared row builder
// (_shared/evidence/ghl_message.ts) and the one SQL writer
// public.capture_business_event. If GHL's OutboundMessage webhook saved the same
// message first, the writer answers "duplicate" and, when this send carries a
// verified job, upgrades that row's link to the job (the upgrade rule). A
// duplicate is a saved row, never a failure. There is no second write path.

import { buildGhlMessageRow, type GhlMessageBuild } from "../_shared/evidence/ghl_message.ts";

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
export function sendSmsJobCustody(jobId: string | null | undefined, job: SendSmsJobRead | null | undefined, contactId: string): {
  verifiedJobId: string | null;
  unverifiedJobId: string | null;
} {
  const named = typeof jobId === "string" && jobId.trim() ? jobId.trim() : null;
  if (!named) return { verifiedJobId: null, unverifiedJobId: null };
  if (job && typeof job.ghl_contact_id === "string" && job.ghl_contact_id === contactId) {
    return { verifiedJobId: named, unverifiedJobId: null };
  }
  return { verifiedJobId: null, unverifiedJobId: named };
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
}

/** The row for a text our tool just sent, built by the shared builder. */
export function buildSendSmsEvidenceRow(input: SendSmsEvidenceInput): GhlMessageBuild {
  const custody = sendSmsJobCustody(input.jobId, input.job, input.contactId);
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
  });
}

export type CaptureOutcome =
  | { outcome: "inserted"; id: string; job_id: string | null; attribution_status: string | null }
  | { outcome: "duplicate"; id: string; job_id: string | null; attribution_status: string | null; upgraded: boolean }
  | { outcome: "capture_disabled" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "error"; code: string };

/**
 * Save one send through capture_business_event. Never throws: the text has
 * already gone, so an evidence problem is reported, logged by code and id only,
 * and left for the reconciler to recover.
 */
// deno-lint-ignore no-explicit-any
export async function saveSendSmsEvidence(client: any, input: SendSmsEvidenceInput): Promise<CaptureOutcome> {
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
    const { data, error } = await client.rpc("capture_business_event", { p_row: built.row });
    if (error) {
      console.error(`[ghl-proxy] send_sms evidence rpc failed: ${error.code ?? "unknown"} ${built.row.provider_message_id}`);
      return { outcome: "error", code: String(error.code ?? "rpc_error") };
    }
    const outcome = data && typeof data === "object" ? data as CaptureOutcome : { outcome: "error" as const, code: "rpc_no_result" };
    if (outcome.outcome === "error") {
      console.error(`[ghl-proxy] send_sms evidence refused: ${outcome.code} ${built.row.provider_message_id}`);
    }
    return outcome;
  } catch {
    console.error(`[ghl-proxy] send_sms evidence rpc threw ${built.row.provider_message_id}`);
    return { outcome: "error", code: "rpc_threw" };
  }
}
