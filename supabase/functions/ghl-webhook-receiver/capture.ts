// ════════════════════════════════════════════════════════════
// GHL webhook receiver: message and rank-10 capture through the one builder
// and the one writer (context build slice C1c; design sms.md §2, §3, §7).
//
// InboundMessage / OutboundMessage and the GHL app's NoteCreate, NoteUpdate,
// TaskCreate, TaskComplete, TaskDelete, AppointmentCreate, AppointmentUpdate
// and AppointmentDelete are built by _shared/evidence/ghl_message.ts and saved
// only through public.capture_business_event. The receiver never chooses a
// job: the database ladder places every row (no receiver matcher, no body
// job id, no inline nudge or proposal cancellation: sms.md §11 "at M1").
//
// Behind feature flag `ghl_message_capture_v2`, read fail closed (missing,
// unreadable or false = off). Off: nothing is written and the receipt says
// capture_disabled (reason flag_off); the 15-minute reconciler (C1d) catches
// up once the flag is on. This slice never turns the flag on.
//
// A message webhook without a GHL message id writes nothing from its body
// (review M8: no composite key). The receiver makes one immediate targeted read
// of that conversation (newest 20 messages, which always carry ids) and saves
// each through the same builder and writer under ghl:<id>. If the read fails,
// the reconciler covers it. Either way the receipt says unresolved_id.
//
// CallCompleted (slice T1, transcripts.md §2 review B2) branches on the same
// flag. Off, the handler keeps writing today's legacy client.call_complete row,
// so every call still reaches the job read before live capture. On, the post is
// a doorbell only: it writes nothing itself and makes the same targeted read of
// the contact's newest conversation, so the call arrives once, through the builder,
// as client.call_logged under ghl:<GHL message id> (callCompletedDoorbell).
//
// Nothing here logs message text, names, numbers or addresses: ids and codes.
// ════════════════════════════════════════════════════════════

import {
  buildGhlMessageRow,
  buildGhlRecordRow,
  type GhlMessageBuild,
  type GhlMessageItem,
  type GhlRecordBody,
  type GhlRecordEventType,
  isGhlRecordEventType,
} from "../_shared/evidence/ghl_message.ts";
import { isFlagOn } from "../_shared/evidence/feature_flag.ts";
import {
  GhlProviderReadError,
  readGhlProvider,
} from "../ghl-proxy/provider_reads.ts";
import { errorCode, safeId } from "./receiver_auth.ts";

/** business_events.source for every row this receiver saves. */
export const RECEIVER_SOURCE = "ghl-webhook-receiver";

/** The item flag for live GHL message capture (sms.md §7 step 4). */
export const MESSAGE_CAPTURE_FLAG = "ghl_message_capture_v2" as const;

/** The messages the targeted read asks for (sms.md §3: newest 20). */
export const TARGETED_READ_LIMIT = 20;

/** Per-request bound on the targeted read, so a slow provider cannot hold the webhook. */
export const TARGETED_READ_REQUEST_MS = 5_000;

export const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "InboundMessage",
  "OutboundMessage",
]);

export function isCapturedEventType(type: unknown): boolean {
  return (typeof type === "string" && MESSAGE_EVENT_TYPES.has(type)) ||
    isGhlRecordEventType(type);
}

export interface TargetedRead {
  status: "ok" | "failed" | "skipped";
  code: string | null;
  seen: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  errors: number;
}

/** What one delivery did, for the response and both receipts. Ids and codes only. */
export interface CaptureResult {
  outcome:
    | "event_created"
    | "duplicate"
    | "capture_disabled"
    | "skipped"
    | "unresolved_id"
    | "error";
  /** A code: flag_off, lane_off, a builder skip reason, or a writer code. */
  reason: string | null;
  /** business_events.id of the saved row (inserted or the existing duplicate). */
  eventId: string | null;
  upgraded: boolean;
  /** The id this delivery is about: the GHL message, note, task or appointment id. */
  itemId: string | null;
  targeted: TargetedRead | null;
  /** HTTP status to answer GHL with: 500 asks GHL to retry (sms.md §8 F3). */
  httpStatus: 200 | 500;
}

// deno-lint-ignore no-explicit-any
type Db = any;

type WriteOutcome =
  | { outcome: "inserted" | "duplicate"; id: string | null; upgraded: boolean }
  | { outcome: "capture_disabled" }
  | { outcome: "error"; code: string };

/** Save one built row through capture_business_event. Never throws. */
export async function writeCapturedRow(
  client: Db,
  row: Record<string, unknown>,
): Promise<WriteOutcome> {
  try {
    const { data, error } = await client.rpc("capture_business_event", {
      p_row: row,
    });
    if (error) return { outcome: "error", code: errorCode(error) };
    const out = data && typeof data === "object"
      ? data as Record<string, unknown>
      : null;
    const kind = out?.outcome;
    if (kind === "inserted" || kind === "duplicate") {
      return {
        outcome: kind,
        id: safeId(out?.id),
        upgraded: out?.upgraded === true,
      };
    }
    if (kind === "capture_disabled") return { outcome: "capture_disabled" };
    return {
      outcome: "error",
      code: safeId(out?.code) ?? "capture_no_result",
    };
  } catch (e) {
    return { outcome: "error", code: errorCode(e) };
  }
}

function fromWrite(
  written: WriteOutcome,
  itemId: string | null,
): CaptureResult {
  const base = { itemId, targeted: null, upgraded: false };
  if (written.outcome === "inserted" || written.outcome === "duplicate") {
    return {
      ...base,
      outcome: written.outcome === "inserted" ? "event_created" : "duplicate",
      reason: null,
      eventId: written.id,
      upgraded: written.upgraded,
      httpStatus: 200,
    };
  }
  if (written.outcome === "capture_disabled") {
    return {
      ...base,
      outcome: "capture_disabled",
      reason: "lane_off",
      eventId: null,
      httpStatus: 200,
    };
  }
  return {
    ...base,
    outcome: "error",
    reason: written.outcome === "error" ? written.code : "capture_no_result",
    eventId: null,
    httpStatus: 500,
  };
}

/** The GHL message item carried by an app message webhook. */
export function messageItemFromWebhook(
  body: Record<string, unknown>,
): GhlMessageItem {
  const given = typeof body.direction === "string" ? body.direction : null;
  return {
    ...(body as GhlMessageItem),
    // App webhooks say which way by their type when the body does not.
    direction: given ??
      (body.type === "OutboundMessage" ? "outbound" : "inbound"),
  };
}

/** A fetch that gives each provider request at most `ms` milliseconds. */
function boundedFetch(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return fetchImpl(input, { ...init, signal });
  }) as typeof fetch;
}

/**
 * One immediate read of the conversation a webhook named without a message id:
 * its newest messages, each saved through the builder and writer. Never throws.
 */
export async function targetedConversationRead(
  client: Db,
  body: Record<string, unknown>,
  deps: {
    env: (name: string) => string | undefined;
    fetch: typeof fetch;
  },
): Promise<TargetedRead> {
  const read: TargetedRead = {
    status: "skipped",
    code: null,
    seen: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
  };
  const contactId = safeId(body.contactId);
  const conversationId = safeId(body.conversationId);
  if (!contactId || !conversationId) {
    read.code = "no_conversation";
    return read;
  }
  const token = deps.env("GHL_API_TOKEN") ?? "";
  const locationId = (deps.env("GHL_LOCATION_ID") ?? "").trim();
  if (!token || !locationId) {
    read.code = "provider_not_configured";
    return read;
  }
  let items: GhlMessageItem[];
  try {
    const result = await readGhlProvider(
      "list_ghl_messages",
      new URLSearchParams({
        contact_id: contactId,
        conversation_id: conversationId,
        limit: String(TARGETED_READ_LIMIT),
      }),
      {
        locationId,
        token,
        fetchFn: boundedFetch(deps.fetch, TARGETED_READ_REQUEST_MS),
      },
    );
    const container = (result.data as { messages?: { messages?: unknown } })
      ?.messages;
    items = Array.isArray(container?.messages)
      ? container.messages as GhlMessageItem[]
      : [];
  } catch (e) {
    read.status = "failed";
    read.code = e instanceof GhlProviderReadError ? e.code : errorCode(e);
    return read;
  }
  read.status = "ok";
  for (const item of items) {
    read.seen++;
    const built: GhlMessageBuild = buildGhlMessageRow(item, {
      source: RECEIVER_SOURCE,
      captureMode: "live",
    });
    if (built.kind === "skip") {
      read.skipped++;
      continue;
    }
    const written = await writeCapturedRow(client, built.row);
    if (written.outcome === "inserted") read.inserted++;
    else if (written.outcome === "duplicate") read.duplicates++;
    else if (written.outcome === "capture_disabled") read.skipped++;
    else if (written.outcome === "error") {
      read.errors++;
      read.code ??= written.code;
    }
  }
  return read;
}

/**
 * The contact's newest GHL conversation, for a post that names the contact
 * only (GHL workflow posts such as CallCompleted). Never throws.
 */
async function newestConversationId(
  contactId: string,
  deps: {
    env: (name: string) => string | undefined;
    fetch: typeof fetch;
  },
): Promise<{ id: string | null; code: string | null }> {
  const token = deps.env("GHL_API_TOKEN") ?? "";
  const locationId = (deps.env("GHL_LOCATION_ID") ?? "").trim();
  if (!token || !locationId) {
    return { id: null, code: "provider_not_configured" };
  }
  try {
    const result = await readGhlProvider(
      "list_ghl_conversations",
      new URLSearchParams({ contact_id: contactId, limit: "1" }),
      {
        locationId,
        token,
        fetchFn: boundedFetch(deps.fetch, TARGETED_READ_REQUEST_MS),
      },
    );
    const rows = (result.data as { conversations?: unknown })?.conversations;
    const id = Array.isArray(rows)
      ? safeId((rows[0] as { id?: unknown } | undefined)?.id)
      : null;
    return id ? { id, code: null } : { id: null, code: "no_conversation" };
  } catch (e) {
    return {
      id: null,
      code: e instanceof GhlProviderReadError ? e.code : errorCode(e),
    };
  }
}

/**
 * CallCompleted while live capture is on (slice T1): a doorbell. The post
 * writes nothing itself; one targeted read of the contact's newest conversation saves
 * the call item (and any other missing item) through the builder and writer.
 * The post's conversation id is ignored. When the read cannot run, the
 * 15-minute reconciler covers the
 * call. The caller has authenticated the post, checked the capture lane and
 * read the flag on. Never throws.
 */
export async function callCompletedDoorbell(
  client: Db,
  body: Record<string, unknown>,
  deps: {
    env: (name: string) => string | undefined;
    fetch: typeof fetch;
  },
): Promise<CaptureResult> {
  const contactId = safeId(body.contactId);
  const newest = contactId
    ? await newestConversationId(contactId, deps)
    : { id: null, code: null };
  const conversationId = newest.id;
  const targeted = conversationId
    ? await targetedConversationRead(
      client,
      { contactId, conversationId },
      deps,
    )
    : {
      status: "skipped" as const,
      code: newest.code ?? (contactId ? "no_conversation" : "no_contact"),
      seen: 0,
      inserted: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0,
    };
  const failed = targeted.errors > 0;
  return {
    outcome: failed ? "error" : "skipped",
    reason: failed
      ? targeted.code ?? "capture_no_result"
      : targeted.status === "ok"
      ? "call_doorbell"
      : targeted.code,
    eventId: null,
    upgraded: false,
    itemId: null,
    targeted,
    // A failed save of a row the read did find is a real error: GHL retries.
    httpStatus: failed ? 500 : 200,
  };
}

/** Whether live GHL capture is switched on for this item (fail closed). */
export async function messageCaptureEnabled(client: Db): Promise<boolean> {
  // isFlagOn's key type lists the evidence flags only; the query is by name and
  // shape-compatible (the same cast getRefsValidatorMode uses). Kept here so
  // the shared flag module, and every function importing it, is untouched.
  // deno-lint-ignore no-explicit-any
  return await isFlagOn(client, MESSAGE_CAPTURE_FLAG as any);
}

/**
 * Capture one InboundMessage / OutboundMessage or rank-10 delivery. The caller
 * has authenticated it and checked the capture lane. Never throws.
 */
export async function captureGhlDelivery(
  client: Db,
  body: Record<string, unknown>,
  deps: {
    env: (name: string) => string | undefined;
    fetch: typeof fetch;
  },
): Promise<CaptureResult> {
  const type = body.type;
  const isRecord = isGhlRecordEventType(type);
  const itemId = isRecord
    ? safeId(
      type.startsWith("Appointment")
        ? (body.appointment as Record<string, unknown> | undefined)?.id
        : body.id,
    )
    : safeId(body.messageId ?? body.message_id);

  if (!(await messageCaptureEnabled(client))) {
    return {
      outcome: "capture_disabled",
      reason: "flag_off",
      eventId: null,
      upgraded: false,
      itemId,
      targeted: null,
      httpStatus: 200,
    };
  }

  let built: GhlMessageBuild;
  try {
    built = isRecord
      ? buildGhlRecordRow(
        type as GhlRecordEventType,
        body as GhlRecordBody,
        { source: RECEIVER_SOURCE, captureMode: "live" },
      )
      : buildGhlMessageRow(messageItemFromWebhook(body), {
        source: RECEIVER_SOURCE,
        captureMode: "live",
      });
  } catch {
    built = { kind: "skip", reason: "unsupported_type" };
  }

  if (built.kind === "skip") {
    if (!isRecord && built.reason === "no_id") {
      const targeted = await targetedConversationRead(client, body, deps);
      return {
        outcome: "unresolved_id",
        reason: targeted.code,
        eventId: null,
        upgraded: false,
        itemId: null,
        targeted,
        // A failed save of a row the read did find is a real error: GHL retries.
        httpStatus: targeted.errors > 0 ? 500 : 200,
      };
    }
    return {
      outcome: "skipped",
      reason: built.reason,
      eventId: null,
      upgraded: false,
      itemId,
      targeted: null,
      httpStatus: 200,
    };
  }

  return fromWrite(await writeCapturedRow(client, built.row), itemId);
}
