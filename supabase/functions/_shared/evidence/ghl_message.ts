// The one mapping from a GHL conversation item to a business_events row
// (context build plan slice C1a; design sms.md §2 and §3).
//
// Every door that saves a GHL message builds its row here and saves it through
// the SQL writer public.capture_business_event(p_row jsonb): today ghl-proxy's
// send_sms; later the webhook receiver (C1c) and the 15-minute reconciler
// (C1d). Ported from the runtime's lead-thread-capture.ts buildCaptureRow, with
// the design's changes:
//   * key is ghl:<GHL message id> only. No id means no row (review M8);
//   * thread_key is always null: a GHL conversation is per contact, not per
//     job, so it never acts as a job thread (finding 5, review S5). The
//     conversation id is kept in conversation_key (column and payload);
//   * event_at is GHL's own time (dateAdded). Ingestion time is never used as
//     event time; occurred_at is stamped by the writer at write (review M10);
//   * the body is kept whole in payload.body (no 500-character cut);
//   * outbound texts say who sent them: staff in the GHL app, a GHL workflow,
//     or our own tools; internal comments are internal, never "we texted";
//   * calls, voicemails and activity items are not written here (calls stay
//     with CallCompleted until one call writer exists); the caller counts them.
//
// Pure: no I/O, no clock, no model call. The caller supplies the capture mode
// and, for our own sends, the job id it verified.

import { sourceTime } from "../source_time.ts";

/** The SecureWorks GHL marketplace app (the one our tools send through). */
export const SECUREWORKS_GHL_APP_ID = "69a41803c86f294a620b6499";

/** How a row was captured. Only live rows may ever wake an extraction read. */
export type CaptureMode = "live" | "backfill" | "relink";

/** Who wrote an item. */
export type SentByKind =
  | "customer"
  | "staff_app"
  | "workflow"
  | "our_tool"
  | "unknown";

/**
 * One GHL item as either door sees it: an app webhook body
 * (InboundMessage / OutboundMessage: messageId, messageType "SMS") or a
 * conversation message list item (id, messageType "TYPE_SMS").
 */
export interface GhlMessageItem {
  id?: string | null;
  messageId?: string | null;
  messageType?: string | null;
  direction?: string | null;
  status?: string | null;
  body?: string | null;
  dateAdded?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  attachments?: unknown[] | null;
  source?: string | null;
  userId?: string | null;
  from?: string | null;
  to?: string | null;
  emailMessageId?: string | null;
  meta?: {
    email?: { messageIds?: unknown } | null;
    marketplace?: { appId?: unknown } | null;
  } | null;
}

export interface GhlCaptureContext {
  /** business_events.source for the row, e.g. "ghl-proxy". */
  source: string;
  captureMode: CaptureMode;
  /**
   * Set only by a writer that sent the message itself and confirmed the job
   * belongs to the message's contact. Recorded as a direct writer job id
   * (match_method direct_job_id), which the ladder keeps as step 1.
   */
  verifiedJobId?: string | null;
  /** A job id the caller named but could not confirm. Recorded as a hint only. */
  unverifiedJobId?: string | null;
  /** Our number the item was sent from or to, when the item does not carry it. */
  ourNumber?: string | null;
  /** Set by our own sending tools: the item is ours whatever GHL says. */
  sentByKind?: SentByKind;
  /** sha-256 of the body, for the sender's 10-minute duplicate-send check. */
  bodyHash?: string | null;
}

export type GhlSkipReason =
  | "no_id"
  | "no_contact"
  | "no_direction"
  | "skipped_call"
  | "skipped_activity"
  | "unsupported_type";

export type GhlMessageBuild =
  | { kind: "row"; row: Record<string, unknown> }
  | { kind: "skip"; reason: GhlSkipReason };

const GHL_ID = /^[A-Za-z0-9_-]{6,64}$/;
const EXCERPT = 500;

/** Our five lines (last nine digits) and the business line each one decides. */
const OUR_LINES: Record<
  string,
  { from_line: string; line: "fencing" | "patio" | null }
> = {
  "489267771": { from_line: "771", line: null }, // Group Admin
  "489267772": { from_line: "772", line: "fencing" }, // Fencing Sales
  "489267774": { from_line: "774", line: "patio" }, // Patios (does not decide patio against decking)
  "489267776": { from_line: "776", line: null }, // Group Ops
  "489267778": { from_line: "778", line: "fencing" }, // Fencing Mgmt
};

/**
 * The business line of one of our numbers. 772 and 778 are fencing, 774 is
 * patio, 771 and 776 decide nothing. A number that is not ours has no line.
 */
export function ourLineForNumber(
  raw: string | null | undefined,
): {
  from_line: string | null;
  line: "fencing" | "patio" | null;
  our_number: string | null;
} {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const known = digits.length >= 9 ? OUR_LINES[digits.slice(-9)] : undefined;
  if (!known) return { from_line: null, line: null, our_number: null };
  return { ...known, our_number: `+61${digits.slice(-9)}` };
}

/** GHL's message type, upper case, TYPE_ prefix and separators removed: "TYPE_SMS" and "SMS" both read "SMS". */
function messageKind(raw: string | null | undefined): string {
  return String(raw ?? "").toUpperCase().replace(/^TYPE_/, "").replace(
    /[^A-Z0-9]/g,
    "",
  );
}

function attachmentTypes(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((item) => {
    const link = typeof item === "string"
      ? item
      : typeof (item as { url?: unknown })?.url === "string"
      ? (item as { url: string }).url
      : "";
    const name = link.split(/[?#]/)[0].split("/").pop() ?? "";
    return /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1].toLowerCase() ?? "unknown";
  });
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sentBy(
  item: GhlMessageItem,
  direction: string,
  ctx: GhlCaptureContext,
): SentByKind {
  if (direction === "inbound") return "customer";
  if (ctx.sentByKind) return ctx.sentByKind;
  if (item.meta?.marketplace?.appId === SECUREWORKS_GHL_APP_ID) {
    return "our_tool";
  }
  const source = String(item.source ?? "").toLowerCase();
  // sms.md §2 / R4: only source workflow maps to sent_by_kind workflow.
  if (source === "workflow") return "workflow";
  if (text(item.userId)) return "staff_app";
  return "unknown";
}

/** The row for one GHL item, or why it is not written. */
export function buildGhlMessageRow(
  item: GhlMessageItem,
  ctx: GhlCaptureContext,
): GhlMessageBuild {
  const id = text(item.messageId) ?? text(item.id);
  if (!id || !GHL_ID.test(id)) return { kind: "skip", reason: "no_id" };
  const contactId = text(item.contactId);
  if (!contactId) return { kind: "skip", reason: "no_contact" };

  const kind = messageKind(item.messageType);
  if (kind === "CALL" || kind === "VOICEMAIL" || kind === "IVRCALL") {
    return { kind: "skip", reason: "skipped_call" };
  }
  if (kind.startsWith("ACTIVITY")) {
    return { kind: "skip", reason: "skipped_activity" };
  }

  const given = String(item.direction ?? "").toLowerCase();
  let channel: "sms" | "email" | "note";
  let direction: "inbound" | "outbound" | "internal";
  let eventType: string;
  if (kind === "INTERNALCOMMENT") {
    // GHL marks staff comments outbound to the customer's number. They are ours, internal, never a text.
    channel = "note";
    direction = "internal";
    eventType = "ghl.internal_comment";
  } else if (kind === "SMS" || kind === "MMS" || kind === "EMAIL") {
    if (given !== "inbound" && given !== "outbound") {
      return { kind: "skip", reason: "no_direction" };
    }
    channel = kind === "EMAIL" ? "email" : "sms";
    direction = given;
    eventType = direction === "inbound"
      ? (channel === "email" ? "client.email_in" : "client.reply")
      : (channel === "email" ? "client.email_out" : "client.sms_out");
  } else {
    return { kind: "skip", reason: "unsupported_type" };
  }

  const body = typeof item.body === "string" && item.body.trim()
    ? item.body
    : null;
  const types = attachmentTypes(item.attachments);
  // Capture's own bracketed account of an item with no words. Attachment
  // count and file types only: never a link, never a file name.
  const described = body
    ? null
    : `[No text.${
      types.length
        ? ` ${types.length} attachment${types.length === 1 ? "" : "s"}: ${
          types.join(", ")
        }.`
        : " No attachments."
    }]`;
  const read = body ?? described ?? "";

  // Our number: the one texted (inbound) or the one sent from (outbound).
  const numberOnItem = direction === "inbound" ? item.to : item.from;
  const line = ourLineForNumber(text(ctx.ourNumber) ?? text(numberOnItem));
  const sentByKind = direction === "internal"
    ? (text(item.userId) ? "staff_app" : "unknown")
    : sentBy(item, direction, ctx);

  const eventAt = sourceTime(item.dateAdded);
  const emailIds = item.meta?.email?.messageIds;
  const emailMessageId = text(item.emailMessageId) ??
    (Array.isArray(emailIds) && typeof emailIds[0] === "string"
      ? emailIds[0]
      : null);
  const verifiedJobId = text(ctx.verifiedJobId);
  const hintJobId = verifiedJobId ? null : text(ctx.unverifiedJobId);

  const payload: Record<string, unknown> = {
    ...(body
      ? {
        body,
        text: body,
        message: body,
        message_text: body.slice(0, EXCERPT),
      }
      : { described_by_capture: true }),
    channel,
    direction,
    ghl_message_id: id,
    ghl_contact_id: contactId,
    ghl_message_type: item.messageType ?? null,
    conversation_key: text(item.conversationId),
    conversation_id: text(item.conversationId),
    sent_by_kind: sentByKind,
    sent_by_user: direction === "inbound" ? null : text(item.userId),
    line: line.line,
    from_line: line.from_line,
    our_number: line.our_number,
    provider_source: text(item.source),
    provider_status: text(item.status),
    attachments: { count: types.length, types },
    event_at_source: eventAt ? "provider" : "missing",
  };
  if (emailMessageId) payload.email_message_id = emailMessageId;
  if (ctx.bodyHash) payload.body_hash = ctx.bodyHash;

  return {
    kind: "row",
    row: {
      event_type: eventType,
      source: ctx.source,
      entity_type: "contact",
      entity_id: contactId,
      contact_id: contactId,
      job_id: verifiedJobId ?? hintJobId,
      match_method: verifiedJobId ? "direct_job_id" : "none",
      event_at: eventAt,
      provider_message_id: `ghl:${id}`,
      channel,
      direction,
      thread_key: null,
      conversation_key: text(item.conversationId),
      body_preview: read.slice(0, EXCERPT),
      safe_summary: read.slice(0, 280),
      ...(ctx.bodyHash ? { body_hash: ctx.bodyHash } : {}),
      privacy_classification: "staff_only",
      retention_class: "7y_audit",
      payload,
      metadata: { capture_mode: ctx.captureMode },
    },
  };
}
