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
//     written here; the caller counts them.
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
