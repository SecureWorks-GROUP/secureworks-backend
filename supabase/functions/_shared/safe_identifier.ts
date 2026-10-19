// Identifiers that may leave a function in a reply or a stored row.
//
// Provider replies and exceptions carry free text: Graph's error message,
// recipient addresses, SQL detail, a stack. None of it may reach a response or
// a stored error column. What may pass is a short machine identifier (a code, a
// state, an error class name) or a provider id (a Graph message id, an
// internetMessageId, a GHL message id), and only when it has the shape of one,
// so free text can never ride along under one of those names.

/** A code, state or error name: letters, digits and _ . : - only, 1 to 64 long. */
export const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * A provider id (a Graph message or draft id, a GHL contact or message id):
 * base64, base64url or hex-like characters only, 1 to 256 long. No '@', so an
 * address can never pass as an id.
 */
export const SAFE_PROVIDER_ID = /^[A-Za-z0-9_+=\/-]{1,256}$/;

/**
 * An RFC 5322 Message-ID as Graph reports it on a draft (`<local@host>`). It is
 * the one id that carries '@', so it has its own helper: bracketed, id-like
 * characters on both sides, and only ever stored as the message's id, never
 * logged.
 */
export const SAFE_INTERNET_MESSAGE_ID = /^<[A-Za-z0-9._+=\/-]{1,200}@[A-Za-z0-9.-]{1,200}>$/;

/** A Postgres SQLSTATE (`42P01`) or PostgREST code (`PGRST116`). */
export const SAFE_STORE_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;

export function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}

export function safeProviderId(value: unknown): string | null {
  return typeof value === "string" && SAFE_PROVIDER_ID.test(value) ? value : null;
}

export function safeInternetMessageId(value: unknown): string | null {
  return typeof value === "string" && SAFE_INTERNET_MESSAGE_ID.test(value) ? value : null;
}

/** A database error's code when it is a store code; anything else is null. */
export function safeStoreCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_STORE_CODE.test(value) ? value : null;
}

// States and codes a send reply may carry. These are ours, so they are closed
// sets: a value outside them is reported as 'unrecognised', never echoed.

export const SEND_REPLY_STATES = [
  "sending",
  "sent",
  "failed",
  "outcome_unknown",
  "refused",
  "not_sent",
] as const;

export const SEND_REPLY_CODES = [
  "accepted_not_delivered",
  "approval_prior_outcome_unknown",
  "approved_send_error",
  "attachment_download_failed",
  "attachment_invalid_response",
  "attachment_source_not_allowed",
  "audit_write_failed",
  "draft_created_not_sent",
  "draft_deduplication_unavailable",
  "draft_not_sent",
  "group_route_required",
  "internal_report_not_allowed",
  "invalid_action",
  "invalid_attachment",
  "invalid_input",
  "invalid_recipient",
  "invalid_request",
  "invalid_send_claim",
  "invalid_source",
  "invoice_email_failed",
  "invoice_email_outcome_unknown",
  "invoice_email_refused",
  "invoice_link_required",
  "invoice_not_found",
  "invoice_send_in_progress",
  "mailbox_unverified",
  "no_quote_recipients",
  "not_found",
  "not_sent",
  "operator_access_required",
  "outcome_unknown",
  "pdf_provenance_required",
  "provider_draft_mismatch",
  "provider_error",
  "provider_failed_at_draft",
  "provider_outcome_unknown",
  "provider_rejected",
  "quote_email_delivery_failed",
  "reconciled_not_sent",
  "reply_recipient_mismatch",
  "reply_recipients_required",
  "reply_sender_only_required",
  "review_required",
  "sealed_ses_fence_check_failed",
  "sealed_ses_release_required",
  "send_claim_attempt_exists",
  "send_claim_dispatch_taken",
  "send_claim_held",
  "send_claim_invalid",
  "send_claim_item_mismatch",
  "send_claim_not_sending",
  "send_claim_unavailable",
  "send_claim_unreadable",
  "send_dispatch_fenced",
  "send_error",
  "send_reconcile_actor_required",
  "send_reconcile_attempt_mismatch",
  "send_reconcile_invalid",
  "send_reconcile_live_send",
  "send_reconcile_state_changed",
  "send_refused",
  "send_runs_in_progress",
  "send_settle_failed",
  "send_settle_invalid_state",
  "shared_key_contained",
  "unauthorized",
] as const;

const SEND_REPLY_STATE_SET: ReadonlySet<string> = new Set(SEND_REPLY_STATES);
const SEND_REPLY_CODE_SET: ReadonlySet<string> = new Set(SEND_REPLY_CODES);

/** Absent is null; a member of the set is itself; anything else is 'unrecognised'. */
function closedSet(set: ReadonlySet<string>, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && set.has(value) ? value : "unrecognised";
}

export function sendReplyState(value: unknown): string | null {
  return closedSet(SEND_REPLY_STATE_SET, value);
}

export function sendReplyCode(value: unknown): string | null {
  return closedSet(SEND_REPLY_CODE_SET, value);
}

/** An HTTP status, 100 to 599, or null. */
export function safeHttpStatus(value: unknown): number | null {
  return httpStatus(value);
}

function httpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

export type SafeErrorFacts = {
  error_name: string | null;
  provider_status?: number;
  provider_code?: string;
};

/**
 * What may be said about a thrown error: its class name, and the provider
 * status and code it carries (on itself or under `context`), each only when it
 * has a safe shape. Never its message.
 */
export function safeErrorFacts(error: unknown): SafeErrorFacts {
  const e = (error && typeof error === "object") ? error as Record<string, unknown> : null;
  const context = (e?.context && typeof e.context === "object") ? e.context as Record<string, unknown> : null;
  const status = httpStatus(context?.provider_status) ?? httpStatus(e?.status);
  const code = safeIdentifier(context?.provider_code) ?? safeIdentifier(e?.code);
  return {
    error_name: safeIdentifier(e?.name),
    ...(status !== null ? { provider_status: status } : {}),
    ...(code !== null ? { provider_code: code } : {}),
  };
}

/** A one-line, text-free description of a thrown error for a stored error column. */
export function safeErrorLine(error: unknown): string {
  const facts = safeErrorFacts(error);
  const parts = [facts.error_name ?? "error"];
  if (facts.provider_status !== undefined) parts.push(`status=${facts.provider_status}`);
  if (facts.provider_code !== undefined) parts.push(`code=${facts.provider_code}`);
  return parts.join(" ");
}
