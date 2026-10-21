// Open the original (CTX-T23, design AC-M6): a read-only view of one captured
// message, for the Matching screen and Find by job, behind the ops-api staff
// front door.
//
//   GET ?action=context_message_original&event_id=<business_events.id>
//
// What it returns, by channel:
//   * email: subject, from, to, cc, the mailbox it was read from, the words the
//     reader kept (payload.body: "Subject:" line first, then the new words,
//     cut at 20,000 characters and flagged) and any forwarded correspondence,
//     plus every attachment the reader's ledger
//     (public.context_email_attachments) holds for the email, each saved or
//     not with the reason in plain words. A ledger read that fails is
//     attachments.read 'failed' with the error, never an empty list.
//   * text: the whole text (GHL keeps it whole in payload.body) and the line.
//   * call: duration, status and line, never words. A call transcript row is a
//     call too: its words are never returned, here or in any field.
//     words_note is "Call words are not shown here."; where_to_listen says
//     where the recording is (GoHighLevel, the contact's conversation).
//
// What it does not do: it serves no file bytes and makes no link to a file.
// The attachments sit in the PRIVATE bucket context-email-attachments, which
// no staff screen can read today; opening a file is a new access and waits on
// the owner's word (attachments.files 'not_available'). It writes nothing,
// places nothing and records no decision.

export class MessageOriginalError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CALL_WORDS_NOTE = "Call words are not shown here.";
export const FILES_NOT_AVAILABLE =
  "Opening the file itself is not available yet: the files are kept private.";

// Why a file was or was not kept, in the words staff read. The keys are the
// ledger's closed status list (context_email_attachments_status_check).
export const ATTACHMENT_STATUS_WORDS: Record<string, string> = {
  stored: "Saved",
  skipped_inline: "Not saved: a picture in the email itself, such as a signature",
  skipped_kind: "Not saved: not a file (an attached email or a link)",
  skipped_too_large: "Not saved: over 15 MB",
  skipped_message_cap: "Not saved: over the 10 files or 30 MB kept per email",
  skipped_scope: "Not saved here: the make-safe intake keeps ses@ files",
  skipped_no_content: "Not saved: Microsoft sent it without its contents",
  failed: "Not saved: reading it failed",
};

// deno-lint-ignore no-explicit-any
type Client = any;

const EVENT_COLUMNS =
  "id,event_type,channel,direction,event_at,occurred_at,provider_message_id,source,body_preview,payload";
// The most file rows one answer lists. Live (21 Oct 2026) the busiest email
// holds 123 ledger rows and 99% hold 48 or fewer; past this cap the answer says
// how the list was cut (more_not_listed), never a silent short list.
export const ATTACHMENT_ROW_CAP = 200;
const ATTACHMENT_COLUMNS =
  "file_name,content_type,size_bytes,status,error_code,created_at,attachment_key";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => s !== null);
  const one = str(v);
  return one ? [one] : [];
}
function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function eventIdFrom(params: URLSearchParams): string {
  const id = (params.get("event_id") ?? "").trim();
  if (!UUID.test(id)) {
    throw new MessageOriginalError("invalid_request", 400, "event_id must be a message id");
  }
  return id.toLowerCase();
}

export type MessageKind = "email" | "text" | "call" | "other";

export function messageKind(row: Record<string, unknown>): MessageKind {
  const channel = str(row.channel)?.toLowerCase();
  const type = str(row.event_type)?.toLowerCase() ?? "";
  if (channel === "call" || type.startsWith("call.") || type.includes("call_")) return "call";
  if (channel === "email" || type.includes("email")) return "email";
  if (channel === "sms" || channel === "text" || type.includes("sms") || type.includes("text")) return "text";
  return "other";
}

// The full words the row holds, never a call's: the email and text builders
// keep the whole message in payload.body; older rows fall back to the other
// body keys and last to the stored preview (flagged as a preview).
function words(payload: Record<string, unknown>, row: Record<string, unknown>) {
  for (const key of ["body", "text", "message"]) {
    const v = str(payload[key]);
    if (v) return { body: v, body_source: key === "body" ? "message" : key };
  }
  const preview = str(row.body_preview);
  return preview ? { body: preview, body_source: "preview_only" } : { body: null, body_source: "none" };
}

export function shapeAttachment(r: Record<string, unknown>) {
  const status = str(r.status) ?? "unknown";
  return {
    file_name: str(r.file_name),
    content_type: str(r.content_type),
    size_bytes: num(r.size_bytes),
    saved: status === "stored",
    status,
    status_words: ATTACHMENT_STATUS_WORDS[status] ?? "Not known whether it was saved",
    error_code: status === "failed" ? str(r.error_code) : null,
  };
}

export async function contextMessageOriginal(client: Client, params: URLSearchParams) {
  const eventId = eventIdFrom(params);
  const { data, error } = await client.from("business_events").select(EVENT_COLUMNS)
    .eq("id", eventId).maybeSingle();
  if (error) throw new MessageOriginalError("message_read_failed", 500, `message read failed: ${errText(error)}`);
  if (!data) throw new MessageOriginalError("message_not_found", 404, "No captured message has that id");
  const row = data as Record<string, unknown>;
  const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
  const kind = messageKind(row);
  const base = {
    event_id: row.id,
    kind,
    event_type: str(row.event_type),
    direction: str(row.direction),
    at: str(row.event_at) ?? str(row.occurred_at),
    at_source: str(row.event_at) ? "message" : "captured",
    read_only: true as const,
  };

  if (kind === "call") {
    return {
      ...base,
      call: {
        duration_seconds: num(payload.duration_seconds),
        status: str(payload.call_status) ?? str(payload.provider_status),
        line: str(payload.line),
        from_line: str(payload.from_line),
        is_transcript_row: (str(row.event_type) ?? "").toLowerCase().includes("transcript"),
        words_shown: false as const,
        words_note: CALL_WORDS_NOTE,
        where_to_listen: "In GoHighLevel: open this contact's conversation and play the call at this time.",
      },
    };
  }

  const w = words(payload, row);
  if (kind === "text") {
    return {
      ...base,
      text: {
        body: w.body,
        body_source: w.body_source,
        line: str(payload.line),
        from_line: str(payload.from_line),
        sent_by_kind: str(payload.sent_by_kind),
      },
    };
  }

  if (kind !== "email") {
    return { ...base, other: { body: w.body, body_source: w.body_source } };
  }

  const email = {
    subject: str(payload.subject),
    from: str(payload.from),
    to: list(payload.to),
    cc: list(payload.cc),
    mailbox: str(payload.mailbox),
    body: w.body,
    body_source: w.body_source,
    body_truncated: payload.body_truncated === true,
    body_chars_total: num(payload.body_chars_total),
    forwarded_correspondence: str(payload.forwarded_correspondence),
    forwarded_truncated: payload.forwarded_correspondence_truncated === true,
  };

  // The email's files: the ledger keyed by the email's provider id. A copy of
  // the same file (skipped_duplicate) is the file already listed, so it is
  // counted, not listed twice.
  const key = str(row.provider_message_id);
  const onRow = num(payload.attachments_total) ?? (Array.isArray(payload.attachments) ? payload.attachments.length : 0);
  let attachments: Record<string, unknown>;
  if (!key || !/^(email|graph):/.test(key)) {
    attachments = { read: "none", reason: "This message was not read by the email reader, so it has no file list.", items: [], on_message: onRow };
  } else {
    const res = await client.from("context_email_attachments").select(ATTACHMENT_COLUMNS)
      .eq("provider_message_id", key).order("created_at", { ascending: true }).limit(ATTACHMENT_ROW_CAP + 1);
    if (res.error) {
      attachments = { read: "failed", error: `attachment list read failed: ${errText(res.error)}`, items: null, on_message: onRow };
    } else {
      const all = (Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
      const rows = all.slice(0, ATTACHMENT_ROW_CAP);
      const dupes = rows.filter((r) => r.status === "skipped_duplicate").length;
      attachments = {
        read: "ok",
        items: rows.filter((r) => r.status !== "skipped_duplicate").map(shapeAttachment),
        copies_not_listed: dupes,
        more_not_listed: all.length > ATTACHMENT_ROW_CAP,
        on_message: onRow,
      };
    }
  }
  return { ...base, email, attachments: { ...attachments, files: "not_available", files_note: FILES_NOT_AVAILABLE } };
}
