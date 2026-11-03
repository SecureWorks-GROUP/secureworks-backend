// The one mapping from a GHL conversation item to a business_events row
// (context build plan slice C1a; design sms.md §2 and §3).
//
// Every door that saves a GHL message builds its row here and saves it through
// the SQL writer public.capture_business_event(p_row jsonb): ghl-proxy's
// send_sms (C1a), the webhook receiver's messages and rank-10 notes, tasks and
// appointments (C1c, buildGhlRecordRow below), and later the 15-minute
// reconciler (C1d). Ported from the runtime's lead-thread-capture.ts buildCaptureRow, with
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
//   * a call (TYPE_CALL, and GHL's voicemail and IVR call types) is one
//     client.call_logged row, channel call, keyed ghl:<id> like a text: the
//     one call record (slice T1, transcripts.md §2). It carries the provider's
//     status, direction and duration as given and no words; a transcript is
//     always a separate row for the same call (T2). Activity items are not
//     written here; the caller counts them;
//   * a text reaction (GHL TYPE_SMS_REACTION, type 45: a tapback such as
//     Liked “<a text>”) is one client.sms_reaction row on channel status,
//     keyed ghl:<id> like a text, never a new text (C7, 3 Nov 2026; see
//     buildReactionRow for why).
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
  /** GHL's numeric type: 2 a text, 45 a text reaction (a single-message read leaves messageType empty). */
  type?: number | string | null;
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
  /** Calls: the provider's call id (the carrier's call sid), when given. */
  altId?: string | null;
  /** Calls, app webhook shape: status and duration at the top level. */
  callStatus?: string | null;
  callDuration?: number | string | null;
  meta?: {
    email?: { messageIds?: unknown } | null;
    marketplace?: { appId?: unknown } | null;
    /** Calls, conversation list shape: status and duration under meta.call. */
    call?: { status?: unknown; duration?: unknown } | null;
  } | null;
}

/**
 * Who a text from one of our own tools went to when that person is not a
 * customer: an installer (crew) or someone in the office (staff). Set only by
 * the sending writer, which knows the recipient; never read off a provider item.
 */
export type RecipientRole = "crew" | "staff";

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
  /** Calls placed by one of our tools: the actor who asked (INTEGRATION X31). */
  initiatedBy?: string | null;
  /**
   * Set by our own sending tools when an outbound text went to crew or staff,
   * never to a customer. Recorded as metadata.recipient_role; the ladder then
   * places the row on the job it is about as internal communication
   * (placement_rule internal_recipient, metadata.audience internal), so no
   * reader takes it for a message to a customer. Any job id is ignored for
   * such a row: the ladder places it from metadata.about_job_id.
   */
  recipientRole?: RecipientRole | null;
  /** The job a crew or staff text is about. Recorded as metadata.about_job_id; the ladder places the row there as internal communication. */
  aboutJobId?: string | null;
  /**
   * The other items of the same conversation the caller holds (a page of the
   * conversation list), so a text reaction can name the text it reacts to.
   * Read only for a reaction; omitted, its target is recorded as not_in_hand.
   */
  inHand?: readonly GhlMessageItem[] | null;
}

export type GhlSkipReason =
  | "no_id"
  | "no_contact"
  | "no_direction"
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
  if (CALL_KINDS.has(kind)) return buildCallRow(item, id, contactId, ctx);
  if (isReactionItem(item)) return buildReactionRow(item, id, contactId, ctx);
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
  // A text to crew or staff is never on a job: the job it is about stays in metadata.
  const recipientRole = direction === "outbound" &&
      (ctx.recipientRole === "crew" || ctx.recipientRole === "staff")
    ? ctx.recipientRole
    : null;
  const aboutJobId = recipientRole ? text(ctx.aboutJobId) : null;
  const verifiedJobId = recipientRole ? null : text(ctx.verifiedJobId);
  const hintJobId = recipientRole || verifiedJobId
    ? null
    : text(ctx.unverifiedJobId);

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
      metadata: {
        capture_mode: ctx.captureMode,
        ...(recipientRole
          ? {
            recipient_role: recipientRole,
            ...(aboutJobId ? { about_job_id: aboutJobId } : {}),
          }
          : {}),
      },
    },
  };
}

// ── Calls: one call record per GHL call item (slice T1; transcripts.md §2, §3) ──
//
// Every door that meets a GHL call item (the conversation read behind the
// receiver's doorbell, the 15-minute reconciler, a targeted read) builds the
// same row here: client.call_logged, channel call, keyed ghl:<GHL message id>,
// the key the runtime's lead-thread-capture already uses, so the two writers
// land one row. Provider facts are copied as given, never interpreted: a
// no-answer is never written as a completed call, and a missing direction is
// `unknown`, never guessed. The row has no words (words: false); capture's own
// bracketed account goes only in body_preview and safe_summary, as for a text
// with no words. The transcript, when GHL has one, is its own row keyed
// ghltx:<same id> (slice T2). A call row is context only: it never wakes an
// extraction read on its own (cadence K-X keys that on the event type).

/** GHL's call item types, as messageKind reads them. */
const CALL_KINDS: ReadonlySet<string> = new Set([
  "CALL",
  "VOICEMAIL",
  "IVRCALL",
]);

/** What a call row says where its words would be (the runtime's lead-thread-capture says the same). */
export const CALL_LOG_TRANSCRIPT_PENDING =
  "Transcript: none in this record; any transcript is a separate event for this call.";

/** Below this a completed call has nothing worth transcribing (transcripts.md §2 step 1). */
const TRANSCRIPT_MIN_SECONDS = 5;

/** The call's duration in seconds as the provider gave it: meta.call (conversation list) or callDuration (app webhook). */
function callDurationSeconds(item: GhlMessageItem): number | null {
  const raw = item.meta?.call?.duration ?? item.callDuration;
  const n = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\d{1,7}(\.\d{1,3})?$/.test(raw.trim())
    ? Number(raw.trim())
    : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The call's status as the provider gave it, verbatim: meta.call, then callStatus, then the item status. */
function callStatusText(item: GhlMessageItem): string | null {
  return text(item.meta?.call?.status) ?? text(item.callStatus) ??
    text(item.status);
}

function buildCallRow(
  item: GhlMessageItem,
  id: string,
  contactId: string,
  ctx: GhlCaptureContext,
): GhlMessageBuild {
  const given = String(item.direction ?? "").toLowerCase();
  const direction: "inbound" | "outbound" | "unknown" =
    given === "inbound" || given === "outbound" ? given : "unknown";
  const status = callStatusText(item);
  const duration = callDurationSeconds(item);
  const read = `[Call, ${
    direction === "unknown" ? "direction not given" : direction
  }. Provider status: ${status ?? "not given"}. Duration: ${
    duration === null ? "none recorded" : `${duration} seconds`
  }. ${CALL_LOG_TRANSCRIPT_PENDING}]`;

  // Our line: the one rung (inbound) or rung from (outbound); either end
  // when the provider gave no direction.
  const numbers = text(ctx.ourNumber)
    ? [ctx.ourNumber]
    : direction === "inbound"
    ? [item.to]
    : direction === "outbound"
    ? [item.from]
    : [item.to, item.from];
  const line =
    numbers.map((n) => ourLineForNumber(text(n))).find((l) => l.our_number) ??
      ourLineForNumber(null);

  const lowered = (status ?? "").toLowerCase();
  const transcriptExpected = lowered === "voicemail" ||
    messageKind(item.messageType) === "VOICEMAIL" ||
    (lowered === "completed" && duration !== null &&
      duration >= TRANSCRIPT_MIN_SECONDS);

  const eventAt = sourceTime(item.dateAdded);
  const verifiedJobId = text(ctx.verifiedJobId);
  const hintJobId = verifiedJobId ? null : text(ctx.unverifiedJobId);
  const altId = text(item.altId);
  const conversationId = text(item.conversationId);
  const initiatedBy = text(ctx.initiatedBy);

  const payload: Record<string, unknown> = {
    described_by_capture: true,
    words: false,
    channel: "call",
    direction,
    ghl_message_id: id,
    ghl_contact_id: contactId,
    ghl_message_type: item.messageType ?? null,
    conversation_key: conversationId,
    conversation_id: conversationId,
    call_sid: altId && GHL_ID.test(altId) ? altId : null,
    call_status: status,
    duration_seconds: duration,
    by_user: text(item.userId),
    line: line.line,
    from_line: line.from_line,
    our_number: line.our_number,
    source: text(item.source),
    provider_status: text(item.status),
    transcript_expected: transcriptExpected,
    event_at_source: eventAt ? "provider" : "missing",
  };
  if (initiatedBy) payload.initiated_by = initiatedBy;

  return {
    kind: "row",
    row: {
      event_type: "client.call_logged",
      source: ctx.source,
      entity_type: "contact",
      entity_id: contactId,
      contact_id: contactId,
      job_id: verifiedJobId ?? hintJobId,
      match_method: verifiedJobId ? "direct_job_id" : "none",
      event_at: eventAt,
      provider_message_id: `ghl:${id}`,
      channel: "call",
      direction,
      thread_key: null,
      conversation_key: conversationId,
      body_preview: read.slice(0, EXCERPT),
      safe_summary: read.slice(0, 280),
      privacy_classification: "staff_only",
      retention_class: "7y_audit",
      payload,
      metadata: { capture_mode: ctx.captureMode },
    },
  };
}

// ── Text reactions: one row per GHL TYPE_SMS_REACTION item (C7, 3 Nov 2026) ──
//
// A reaction is the mark a phone puts on a text that already exists (an
// iPhone tapback, an Android emoji reaction). GHL keeps it as its own item,
// type 45, messageType TYPE_SMS_REACTION in the conversation list ("" from a
// single-message read), whose body is the phone's fallback words:
//   Liked “Sorry yes that was an automation apologies”      (iPhone)
//   Loved “…”, Laughed at “…”, Emphasized “…”, Questioned “…”, Disliked “…”
//   Removed a like from “…”                                 (iPhone, undone)
//   <U+200B>👍<U+200B> to “ Hi …, … ”                         (Android)
// It carries the contact, conversation, direction, our number and GHL's own
// time, but never the id of the text it reacts to: only a copy of its words.
// Read live on 3 Nov 2026 (13 items, 27 Oct to 3 Nov): every one inbound, a
// customer reacting to one of our texts.
//
// The row (every door builds it here):
//   * key ghl:<GHL message id>, contact, conversation_key and event_at as for
//     a text, so the C7 census finds it by the source's own id;
//   * event_type client.sms_reaction, channel status, the direction as given
//     (no direction: no_direction, as for a text). Why status and not sms: a
//     reaction is not a new text and must never read as the customer writing.
//     Every reader that treats an inbound text as the customer writing keys on
//     channel sms (or on client.reply / client.sms_in): the AI notes reader's
//     public.context_ledger_message_kind (channel sms, email, call, note,
//     document), so a status row is never evidence, never cited, cannot open,
//     reopen or close a notes item and never makes a job due a read; the
//     card's messages, open items and last exchange
//     (context_job_record_messages, context_job_record_loops: channel sms or
//     email), so a "Liked" never makes a reply owed; and the lead monitor. A
//     reaction is at most a weak acknowledgement, kept on the job's record
//     and out of every one of those reads;
//   * the ladder places it like any worded row of its contact: the same rules
//     as the text it reacts to, whose words it quotes (a job number in our
//     text places the reaction on that job too). Read-only preview on 3 Nov
//     2026: 13 of 13 would land where their reacted-to text sits (10 on a
//     job, 3 on no job). The capture never names a job itself;
//   * payload.body keeps the provider's words whole, as for every text;
//     body_preview and safe_summary are capture's own short account: the mark
//     and the text it is on, e.g.
//       [Reaction 👍 (Liked) on our text ghl:o6r7C1Sk23UdMcagy04d: “Sorry yes…”]
//   * payload.reaction: the mark (emoji, the provider's verb, removed), the
//     quoted words (cut at 500) and the reacted-to text when the caller holds
//     the conversation (inHand): exactly one earlier text of the same
//     conversation whose words equal the quote after quotes and spaces are
//     straightened (match quoted_text, reacted_to_key ghl:<id>). Several equal
//     texts, none, no quote or nothing in hand are recorded as such, never
//     guessed.

/** GHL's numeric type for a text reaction. */
const REACTION_TYPE = "45";

/** business_events.event_type of a text reaction. */
export const REACTION_EVENT_TYPE = "client.sms_reaction";

/** A GHL text reaction: TYPE_SMS_REACTION, or type 45 with no messageType (single-message read). */
export function isReactionItem(item: GhlMessageItem): boolean {
  const kind = messageKind(item.messageType);
  return kind === "SMSREACTION" ||
    (kind === "" && String(item.type ?? "").trim() === REACTION_TYPE);
}

/** The iPhone tapback words and their marks. */
const TAPBACK_MARKS: Record<string, string> = {
  "liked": "👍",
  "loved": "❤️",
  "disliked": "👎",
  "laughed at": "😂",
  "emphasized": "‼️",
  "emphasised": "‼️",
  "questioned": "❓",
};

/** The iPhone words for a removed tapback ("Removed a like from"). */
const REMOVED_MARKS: Record<string, string> = {
  "like": "👍",
  "heart": "❤️",
  "dislike": "👎",
  "laugh": "😂",
  "exclamation": "‼️",
  "question mark": "❓",
};

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const INVISIBLE = /[​-‍⁠﻿]/g;

/** One reaction as its fallback words say it. */
export interface GhlReaction {
  /** The mark: the emoji itself, or the tapback's emoji. Null when not recognised. */
  emoji: string | null;
  /** The provider's words before the quote, invisible characters removed ("Liked", "👍 to"). */
  verb: string | null;
  /** The phone took the mark back ("Removed a like from …"). */
  removed: boolean;
  /** The words of the text it is on, as quoted, trimmed. Null when there is no quote. */
  quoted: string | null;
}

/** The mark and quote of a reaction body. Pure. */
export function parseGhlReaction(body: string | null | undefined): GhlReaction {
  const raw = String(body ?? "");
  const open = raw.indexOf("“");
  const close = raw.lastIndexOf("”");
  let head = raw;
  let quoted: string | null = null;
  if (open >= 0 && close > open) {
    head = raw.slice(0, open);
    quoted = raw.slice(open + 1, close).trim() || null;
  } else {
    const straight = /^([^"]*)"([\s\S]*)"\s*$/.exec(raw);
    if (straight) {
      head = straight[1];
      quoted = straight[2].trim() || null;
    }
  }
  const verb = head.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const lower = verb.toLowerCase();
  const removed = /^removed\b/.test(lower);
  const word = removed
    ? lower.replace(/^removed\s+(an?\s+)?/, "").replace(/\s+from$/, "")
    : lower.replace(/^reacted\s+/, "").replace(/\s+to$/, "");
  const known = (removed ? REMOVED_MARKS : TAPBACK_MARKS)[word];
  const mark = known ??
    (PICTOGRAPH.test(word) ? word.replace(/\s+/g, "") : null);
  return { emoji: mark, verb: verb || null, removed, quoted };
}

/** Words as the notes store compares them (context_ledger_text_norm): quotes straightened, spaces collapsed. */
function compareText(value: string): string {
  return value
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/ /g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text a reaction is on, as far as the items in hand show it. */
export type ReactionTarget =
  | {
    match: "quoted_text";
    ghlMessageId: string;
    direction: "inbound" | "outbound" | null;
  }
  | { match: "not_in_hand" | "no_quote" | "not_found" }
  | { match: "several"; candidates: number };

/**
 * The one earlier text of the reaction's conversation (or contact, when an
 * item names no conversation) whose words equal the quote. Pure; never
 * guesses between equal texts.
 */
export function findReactionTarget(
  reaction: GhlMessageItem,
  quoted: string | null,
  inHand: readonly GhlMessageItem[] | null | undefined,
): ReactionTarget {
  if (!quoted) return { match: "no_quote" };
  if (!inHand) return { match: "not_in_hand" };
  const selfId = text(reaction.messageId) ?? text(reaction.id);
  const conversation = text(reaction.conversationId);
  const contact = text(reaction.contactId);
  const at = Date.parse(String(reaction.dateAdded ?? ""));
  const want = compareText(quoted);
  const hits = inHand.filter((m) => {
    const id = text(m.messageId) ?? text(m.id);
    if (!id || id === selfId || isReactionItem(m)) return false;
    const kind = messageKind(m.messageType);
    if (kind !== "SMS" && kind !== "MMS") return false;
    const sameThread = conversation && text(m.conversationId)
      ? text(m.conversationId) === conversation
      : !!contact && text(m.contactId) === contact;
    if (!sameThread) return false;
    const when = Date.parse(String(m.dateAdded ?? ""));
    if (Number.isFinite(at) && Number.isFinite(when) && when > at) {
      return false;
    }
    return typeof m.body === "string" && compareText(m.body) === want;
  });
  if (hits.length === 0) return { match: "not_found" };
  if (hits.length > 1) return { match: "several", candidates: hits.length };
  const hit = hits[0];
  const direction = String(hit.direction ?? "").toLowerCase();
  return {
    match: "quoted_text",
    ghlMessageId: (text(hit.messageId) ?? text(hit.id))!,
    direction: direction === "inbound" || direction === "outbound"
      ? direction
      : null,
  };
}

/** The quote as the short account shows it. */
const REACTION_EXCERPT = 120;

function buildReactionRow(
  item: GhlMessageItem,
  id: string,
  contactId: string,
  ctx: GhlCaptureContext,
): GhlMessageBuild {
  const given = String(item.direction ?? "").toLowerCase();
  if (given !== "inbound" && given !== "outbound") {
    return { kind: "skip", reason: "no_direction" };
  }
  const direction: "inbound" | "outbound" = given;
  const body = typeof item.body === "string" && item.body.trim()
    ? item.body
    : null;
  const reaction = parseGhlReaction(body);
  const target = findReactionTarget(item, reaction.quoted, ctx.inHand);
  const targetKey = target.match === "quoted_text"
    ? `ghl:${target.ghlMessageId}`
    : null;

  const mark = reaction.emoji ?? reaction.verb ?? "a mark";
  // The provider's word beside its mark only when it adds one ("Liked"), not
  // when the words already show the emoji ("👍 to") or the mark is unknown.
  const said = reaction.emoji && reaction.verb && !reaction.removed &&
      !reaction.verb.includes(reaction.emoji)
    ? ` (${reaction.verb})`
    : "";
  const on = target.match === "quoted_text"
    ? `${
      target.direction === "outbound" ? "our text" : "the customer's text"
    } ${targetKey}`
    : "a text";
  const oneLine = reaction.quoted?.replace(/\s+/g, " ") ?? null;
  const quote = oneLine
    ? `: “${
      oneLine.length > REACTION_EXCERPT
        ? `${oneLine.slice(0, REACTION_EXCERPT).trimEnd()}...`
        : oneLine
    }”`
    : "";
  const read = reaction.removed
    ? `[Reaction ${mark} taken back from ${on}${quote}]`
    : `[Reaction ${mark}${said} on ${on}${quote}]`;

  // Our number: the one reacted to (inbound) or reacted from (outbound).
  const numberOnItem = direction === "inbound" ? item.to : item.from;
  const line = ourLineForNumber(text(ctx.ourNumber) ?? text(numberOnItem));
  const eventAt = sourceTime(item.dateAdded);
  const conversationId = text(item.conversationId);

  const payload: Record<string, unknown> = {
    ...(body
      ? {
        body,
        text: body,
        message: body,
        message_text: body.slice(0, EXCERPT),
      }
      : { described_by_capture: true }),
    channel: "status",
    direction,
    ghl_message_id: id,
    ghl_contact_id: contactId,
    ghl_message_type: item.messageType ?? null,
    ghl_type: item.type ?? null,
    conversation_key: conversationId,
    conversation_id: conversationId,
    sent_by_kind: sentBy(item, direction, ctx),
    sent_by_user: direction === "inbound" ? null : text(item.userId),
    line: line.line,
    from_line: line.from_line,
    our_number: line.our_number,
    provider_source: text(item.source),
    provider_status: text(item.status),
    reaction: {
      emoji: reaction.emoji,
      verb: reaction.verb,
      removed: reaction.removed,
      quoted_text: reaction.quoted ? reaction.quoted.slice(0, EXCERPT) : null,
      reacted_to_match: target.match,
      reacted_to_key: targetKey,
      reacted_to_ghl_message_id: target.match === "quoted_text"
        ? target.ghlMessageId
        : null,
      reacted_to_direction: target.match === "quoted_text"
        ? target.direction
        : null,
      ...(target.match === "several"
        ? { reacted_to_candidates: target.candidates }
        : {}),
    },
    event_at_source: eventAt ? "provider" : "missing",
  };

  return {
    kind: "row",
    row: {
      event_type: REACTION_EVENT_TYPE,
      source: ctx.source,
      entity_type: "contact",
      entity_id: contactId,
      contact_id: contactId,
      // Never a job from capture: the ladder places it (see above).
      job_id: null,
      match_method: "none",
      event_at: eventAt,
      provider_message_id: `ghl:${id}`,
      channel: "status",
      direction,
      thread_key: null,
      conversation_key: conversationId,
      body_preview: read.slice(0, EXCERPT),
      safe_summary: read.slice(0, 280),
      privacy_classification: "staff_only",
      retention_class: "7y_audit",
      payload,
      metadata: { capture_mode: ctx.captureMode },
    },
  };
}

// ── Transcripts: one row per GHL call transcript (slice T2; transcripts.md §2) ──
//
// The only writer is the ghl-call-transcript-fetch edge function. The row is
// keyed ghltx:<the call's GHL message id>, so every retry, a crashed run and
// the history load land one row. It sits beside its call row and never
// replaces it:
//   * payload.ghl_call_id is the call's GHL message id: the key the runtime's
//     callTranscriptLinks already pairs a transcript to its call by (review M8);
//     payload.call_event_provider_id is the call row's key ghl:<id>;
//   * event_at, contact, direction and line are the call's own. The ladder
//     places the transcript at the call's time like any text (placement slice
//     P-T moves the call to follow it);
//   * the words are stored once: payload.transcript (the attribution and
//     extraction reads take the words from there, context_event_text) and
//     body_preview, its first 500 characters (review M8). payload.turns point
//     into that text;
//   * speaker_roles is always "not_given": a channel is never a role (D-T2);
//   * capture_mode is the call row's (review S8), unless the caller is the
//     history mode, which always writes backfill so a past call never wakes a read.
// safe_summary carries no words: it is capture's own account of the row.

/** The stored call row a transcript belongs to, as the fetcher selected it. */
export interface CallRowFacts {
  /** The call's GHL message id (its row key without the ghl: prefix). */
  ghlMessageId: string;
  contactId: string;
  eventAt: string;
  direction: string | null;
  conversationKey: string | null;
  callSid: string | null;
  durationSeconds: number | null;
  line: string | null;
  fromLine: string | null;
  byUser: string | null;
}

export interface TranscriptRowInput {
  text: string;
  turns: [number | null, number, number, number][];
  speakerLabels: boolean;
  speakerChannels: number[];
  sentenceCount: number;
  sentencesKept: number;
  wordCount: number;
  cut: boolean;
  lowSignal: boolean;
}

export const CALL_TRANSCRIPT_EVENT_TYPE = "call.transcript_completed";
export const CALL_TRANSCRIPT_SOURCE = "ghl-call-transcript";

/** The transcript row for one call. Pure; refuses (skip) a call with no usable id or time. */
export function buildGhlCallTranscriptRow(
  call: CallRowFacts,
  transcript: TranscriptRowInput,
  ctx: {
    captureMode: CaptureMode;
    agreement?: "reached" | "not_reached" | "not_needed";
  },
): GhlMessageBuild {
  const id = text(call.ghlMessageId);
  if (!id || !GHL_ID.test(id)) return { kind: "skip", reason: "no_id" };
  const contactId = text(call.contactId);
  if (!contactId) return { kind: "skip", reason: "no_contact" };
  const eventAt = sourceTime(call.eventAt);
  const direction =
    call.direction === "inbound" || call.direction === "outbound"
      ? call.direction
      : "unknown";
  const summary =
    `[Call transcript, ${direction}. ${transcript.sentenceCount} sentence${
      transcript.sentenceCount === 1 ? "" : "s"
    }, ${transcript.wordCount} word${transcript.wordCount === 1 ? "" : "s"}. ${
      transcript.speakerLabels
        ? `${transcript.speakerChannels.length} speakers, roles not given.`
        : "Speakers not separated by the provider."
    }${transcript.lowSignal ? " Low signal." : ""}]`;
  const payload: Record<string, unknown> = {
    words: true,
    channel: "call",
    direction,
    transcript: transcript.text,
    turns: transcript.turns,
    speaker_labels: transcript.speakerLabels,
    speaker_channels: transcript.speakerChannels,
    speaker_roles: "not_given",
    sentence_count: transcript.sentenceCount,
    word_count: transcript.wordCount,
    low_signal: transcript.lowSignal,
    provider: "ghl",
    transcript_version: "ghl-v3",
    ghl_call_id: id,
    call_event_provider_id: `ghl:${id}`,
    ghl_contact_id: contactId,
    conversation_key: text(call.conversationKey),
    call_sid: text(call.callSid),
    duration_seconds: call.durationSeconds,
    line: text(call.line),
    from_line: text(call.fromLine),
    by_user: text(call.byUser),
    event_at_source: eventAt ? "call" : "missing",
  };
  if (transcript.cut) {
    payload.cut = {
      at_bytes: "64KB",
      sentences_kept: transcript.sentencesKept,
      sentences_total: transcript.sentenceCount,
    };
  }
  if (ctx.agreement) payload.agreement = ctx.agreement;
  return {
    kind: "row",
    row: {
      event_type: CALL_TRANSCRIPT_EVENT_TYPE,
      source: CALL_TRANSCRIPT_SOURCE,
      entity_type: "contact",
      entity_id: contactId,
      contact_id: contactId,
      job_id: null,
      match_method: "none",
      event_at: eventAt,
      provider_message_id: `ghltx:${id}`,
      channel: "call",
      direction,
      thread_key: null,
      conversation_key: text(call.conversationKey),
      body_preview: transcript.text.slice(0, EXCERPT),
      safe_summary: summary.slice(0, 280),
      privacy_classification: "staff_only",
      retention_class: "7y_audit",
      payload,
      metadata: { capture_mode: ctx.captureMode },
    },
  };
}

// ── Rank 10: GHL notes, tasks and appointments (slice C1c; sms.md §2) ──
//
// The same builder maps the GHL app webhooks NoteCreate / NoteUpdate,
// TaskCreate / TaskComplete / TaskDelete and AppointmentCreate / Update /
// Delete. Each delivery is one row of history, never an answer path: the
// current appointment and the open tasks are read live by the dossier.
//
// Keys (sms.md §2 mapping table, review S4). Every edit and every task or
// appointment transition is its own row; a retry of the same delivery lands on
// the same key:
//   ghlnote:<note id>:<version>
//   ghltask:<task id>:<create|complete|delete>:<version>
//   ghlappt:<appointment id>:<create|update|delete>:<version>
// <version> is GHL's own dateUpdated; for a create, else the item's
// dateAdded; else the delivery's event timestamp; else its webhookId. A delivery
// that carries none of them writes nothing (no key, no row: review M8), so an
// edit is never folded into an earlier row.
//
// Channel: notes are `note` / internal (staff words, like internal comments).
// Tasks and appointments are `status` / internal. The design table names
// channels `task` and `calendar`, but the live business_events channel CHECK
// (read from production 23 Sep 2026, pinned in the C1a contract setup) allows
// neither, and that schema belongs to the foundation track (F1). `status` is
// the live channel for internal state changes (the legacy AppointmentCreated
// and stage rows use it); the event type carries the kind, and the cadence
// rules key on the event type (ghl.task_*, ghl.appointment_* ride along).

/** The GHL app webhook types the rank-10 builder maps. */
export const GHL_RECORD_EVENT_TYPES = [
  "NoteCreate",
  "NoteUpdate",
  "TaskCreate",
  "TaskComplete",
  "TaskDelete",
  "AppointmentCreate",
  "AppointmentUpdate",
  "AppointmentDelete",
] as const;
export type GhlRecordEventType = typeof GHL_RECORD_EVENT_TYPES[number];

export function isGhlRecordEventType(
  value: unknown,
): value is GhlRecordEventType {
  return GHL_RECORD_EVENT_TYPES.some((t) => t === value);
}

/** One rank-10 app webhook body, as GHL posts it (appointments nest under `appointment`). */
export interface GhlRecordBody {
  type?: string | null;
  id?: string | null;
  contactId?: string | null;
  body?: string | null;
  title?: string | null;
  userId?: string | null;
  assignedTo?: string | null;
  dueDate?: string | null;
  completed?: boolean | null;
  dateAdded?: string | null;
  dateUpdated?: string | null;
  timestamp?: string | null;
  webhookId?: string | null;
  appointment?: {
    id?: string | null;
    contactId?: string | null;
    calendarId?: string | null;
    title?: string | null;
    appointmentStatus?: string | null;
    assignedUserId?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    dateAdded?: string | null;
    dateUpdated?: string | null;
  } | null;
}

const RECORD_KIND: Record<
  GhlRecordEventType,
  {
    family: "note" | "task" | "appointment";
    action: "create" | "update" | "complete" | "delete";
    eventType: string;
  }
> = {
  NoteCreate: { family: "note", action: "create", eventType: "ghl.note_added" },
  NoteUpdate: {
    family: "note",
    action: "update",
    eventType: "ghl.note_updated",
  },
  TaskCreate: {
    family: "task",
    action: "create",
    eventType: "ghl.task_created",
  },
  TaskComplete: {
    family: "task",
    action: "complete",
    eventType: "ghl.task_completed",
  },
  TaskDelete: {
    family: "task",
    action: "delete",
    eventType: "ghl.task_deleted",
  },
  AppointmentCreate: {
    family: "appointment",
    action: "create",
    eventType: "ghl.appointment_created",
  },
  AppointmentUpdate: {
    family: "appointment",
    action: "update",
    eventType: "ghl.appointment_updated",
  },
  AppointmentDelete: {
    family: "appointment",
    action: "delete",
    eventType: "ghl.appointment_deleted",
  },
};

/** A key segment: GHL ids and ISO times only. Anything else is not a version. */
const KEY_PART = /^[A-Za-z0-9_.:+-]{1,64}$/;

function keyPart(value: unknown): string | null {
  const s = text(value);
  return s && KEY_PART.test(s) ? s : null;
}

/** The row for one rank-10 app webhook, or why it is not written. Pure. */
export function buildGhlRecordRow(
  type: GhlRecordEventType,
  body: GhlRecordBody,
  ctx: { source: string; captureMode: CaptureMode },
): GhlMessageBuild {
  const kind = RECORD_KIND[type];
  const appt = kind.family === "appointment" ? (body.appointment ?? {}) : null;
  const itemId = text(appt ? appt.id : body.id);
  if (!itemId || !GHL_ID.test(itemId)) return { kind: "skip", reason: "no_id" };
  const contactId = text(appt?.contactId) ?? text(body.contactId);
  if (!contactId) return { kind: "skip", reason: "no_contact" };

  const dateAdded = appt ? appt.dateAdded : body.dateAdded;
  const dateUpdated = appt ? appt.dateUpdated : body.dateUpdated;
  const version = keyPart(dateUpdated) ??
    (kind.action === "create" ? keyPart(dateAdded) : null) ??
    keyPart(body.timestamp) ?? keyPart(body.webhookId);
  if (!version) return { kind: "skip", reason: "no_id" };

  const prefix = kind.family === "note"
    ? "ghlnote"
    : kind.family === "task"
    ? "ghltask"
    : "ghlappt";
  const key = kind.family === "note"
    ? `${prefix}:${itemId}:${version}`
    : `${prefix}:${itemId}:${kind.action}:${version}`;

  // Provider time of this change: the edit or transition time, never ingestion.
  const eventAt = sourceTime(dateUpdated) ?? sourceTime(body.timestamp) ??
    (kind.action === "create" ? sourceTime(dateAdded) : null);

  const channel = kind.family === "note" ? "note" : "status";
  const staffUser = kind.family === "appointment"
    ? text(appt?.assignedUserId)
    : text(body.userId);
  const payload: Record<string, unknown> = {
    channel,
    direction: "internal",
    ghl_record_type: type,
    ghl_contact_id: contactId,
    sent_by_kind: text(body.userId) ? "staff_app" : "unknown",
    sent_by_user: text(body.userId),
    event_at_source: eventAt ? "provider" : "missing",
  };
  let read: string;
  if (kind.family === "note") {
    const words = typeof body.body === "string" && body.body.trim()
      ? body.body
      : null;
    read = words ?? "[Note with no text.]";
    payload.ghl_note_id = itemId;
    if (words) {
      Object.assign(payload, {
        body: words,
        text: words,
        message: words,
        message_text: words.slice(0, EXCERPT),
      });
    } else payload.described_by_capture = true;
  } else if (kind.family === "task") {
    const title = text(body.title);
    const words = typeof body.body === "string" && body.body.trim()
      ? body.body
      : null;
    const verb = kind.action === "create"
      ? "created"
      : kind.action === "complete"
      ? "completed"
      : "deleted";
    read = [`Task ${verb}: ${title ?? "(no title)"}`, words].filter(Boolean)
      .join("\n");
    Object.assign(payload, {
      ghl_task_id: itemId,
      title,
      body: words,
      assigned_to: text(body.assignedTo),
      due_date: sourceTime(body.dueDate) ?? text(body.dueDate),
      completed: typeof body.completed === "boolean" ? body.completed : null,
      task_action: kind.action,
    });
  } else {
    const verb = kind.action === "create"
      ? "created"
      : kind.action === "update"
      ? "updated"
      : "deleted";
    const start = sourceTime(appt?.startTime);
    const end = sourceTime(appt?.endTime);
    const status = text(appt?.appointmentStatus);
    read = `Appointment ${verb}: ${text(appt?.title) ?? "(no title)"}${
      start ? `, starts ${start}` : ""
    }${end ? `, ends ${end}` : ""}${status ? `, status ${status}` : ""}`;
    Object.assign(payload, {
      ghl_appointment_id: itemId,
      calendar_id: text(appt?.calendarId),
      title: text(appt?.title),
      start_time: start,
      end_time: end,
      appointment_status: status,
      assigned_user_id: staffUser,
      appointment_action: kind.action,
      // History only: the next booked visit is read live (dossier), never from here.
      answer_path: false,
    });
  }

  return {
    kind: "row",
    row: {
      event_type: kind.eventType,
      source: ctx.source,
      entity_type: "contact",
      entity_id: contactId,
      contact_id: contactId,
      job_id: null,
      match_method: "none",
      event_at: eventAt,
      provider_message_id: key,
      channel,
      direction: "internal",
      thread_key: null,
      conversation_key: null,
      body_preview: read.slice(0, EXCERPT),
      safe_summary: read.slice(0, 280),
      privacy_classification: "staff_only",
      retention_class: kind.family === "note" ? "7y_audit" : "12m_default",
      payload,
      metadata: { capture_mode: ctx.captureMode },
    },
  };
}
