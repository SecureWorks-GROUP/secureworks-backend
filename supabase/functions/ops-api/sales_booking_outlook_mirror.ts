// ════════════════════════════════════════════════════════════
// SALES BOOKING OUTLOOK MIRROR — one Outlook event per GHL appointment
// ════════════════════════════════════════════════════════════
//
// Decision D2 (23 Sep 2026): a booking is made in GHL and the system also
// writes the owner's Outlook calendar, through the mail app's existing Graph
// app-only credential (Calendars.ReadWrite already granted; no new access).
// This module is that Outlook write. The booking executor
// (`sales_booking_execute.ts`, ops-api `sales_booking_book`) calls it after its
// GHL appointment write succeeds, and again on a retry press.
//
// ── DEFAULT OFF ──
// Only the exact server env value `SALES_BOOKING_OUTLOOK_MIRROR_WRITE_ENABLED=true`
// writes. Anything else returns `code: "flag_off"` with the exact request it
// would send, and makes no Graph call at all (not even the lookup).
//
// ── ONE EVENT PER GHL APPOINTMENT ──
// The GHL appointment id is stamped on the event as a named extended property
// (`SALES_BOOKING_GHL_MIRROR_PROPERTY_ID`, shared with the diary read so the
// screen can label a mirror). Before creating, the primary calendar is
// searched for that property; a hit returns `already_mirrored` and writes
// nothing. A lookup that fails writes nothing: absence was not proved. The
// create also carries a deterministic Graph `transactionId` so a retried POST
// is collapsed by Exchange.
//
// ── NO INVITATION ──
// The event has no attendees and `responseRequested:false`, so creating it
// sends no mail to anyone. The mailbox is a server constant per booking
// resource (`SALES_BOOKING_OUTLOOK_MAILBOXES`), never caller-chosen.

import {
  PERTH_TIMEZONE,
  SALES_BOOKING_GHL_MIRROR_PROPERTY_ID,
  SALES_BOOKING_OUTLOOK_MAILBOXES,
} from "./sales_booking_read.ts";
import { getGraphToken, graphFetch } from "../_shared/graph_client.ts";

export const SALES_BOOKING_OUTLOOK_MIRROR_FLAG =
  "SALES_BOOKING_OUTLOOK_MIRROR_WRITE_ENABLED";

export interface OutlookMirrorInput {
  /** Booking resource whose Outlook calendar receives the event (e.g. `marnin`). */
  resource_id: string;
  /** The GHL appointment id just written. The idempotency key. */
  ghl_appointment_id: string;
  client_name: string;
  suburb: string;
  /** Arrival window start, ISO with explicit `Z` or `±HH:MM` offset. */
  arrival_start: string;
  /** Arrival window end, ISO with explicit offset, after the start. */
  arrival_end: string;
  /** Site address for the event location. Optional. */
  address?: string | null;
}

export interface OutlookMirrorRequest {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

export type OutlookMirrorResult =
  | { ok: false; code: "invalid_input"; wrote: false; reason: string }
  | {
    ok: false;
    code: "flag_off";
    dry_run: true;
    wrote: false;
    would_write: OutlookMirrorRequest;
  }
  | {
    ok: true;
    code: "already_mirrored";
    wrote: false;
    outlook_event_id: string;
    ghl_appointment_id: string;
  }
  | {
    ok: true;
    code: "mirrored";
    wrote: true;
    outlook_event_id: string;
    ghl_appointment_id: string;
  }
  | {
    ok: false;
    code: "mirror_lookup_failed" | "mirror_write_failed";
    wrote: false;
    reason: string;
  }
  | {
    /** The POST may or may not have landed. A retry is safe: lookup + transactionId. */
    ok: false;
    code: "mirror_outcome_unknown";
    wrote: false;
    reason: string;
  };

export interface OutlookMirrorGraphResponse {
  status: number;
  body: unknown;
}

export interface OutlookMirrorDependencies {
  env(name: string): string | undefined;
  graphGet(url: string): Promise<OutlookMirrorGraphResponse>;
  graphPost(url: string, body: unknown): Promise<OutlookMirrorGraphResponse>;
}

const GHL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function cleanText(
  value: unknown,
  field: string,
  max: number,
): string | { error: string } {
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} is required` };
  if (trimmed.length > max) return { error: `${field} is too long` };
  if (CONTROL.test(trimmed)) {
    return { error: `${field} has control characters` };
  }
  return trimmed;
}

/** Perth wall-clock `YYYY-MM-DDTHH:MM:SS` for an instant. Perth has no DST. */
function perthLocal(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19);
}

function perthClock(ms: number): string {
  return perthLocal(ms).slice(11, 16);
}

/** Deterministic Graph `transactionId` for one GHL appointment. */
export function outlookMirrorTransactionId(ghlAppointmentId: string): string {
  return `sw-ghl-mirror-${ghlAppointmentId}`;
}

/**
 * Validate the input and build the exact Graph create request. Pure. The
 * title is the owner's existing shape, `Scope: Name, Suburb`; the event spans
 * the arrival window.
 */
export function buildOutlookMirrorRequest(
  input: OutlookMirrorInput,
): { ok: true; request: OutlookMirrorRequest } | {
  ok: false;
  reason: string;
} {
  const mailbox = SALES_BOOKING_OUTLOOK_MAILBOXES[input?.resource_id];
  if (!mailbox) {
    return { ok: false, reason: "resource has no Outlook calendar configured" };
  }
  if (
    typeof input.ghl_appointment_id !== "string" ||
    !GHL_ID.test(input.ghl_appointment_id)
  ) {
    return { ok: false, reason: "ghl_appointment_id is not a GHL id" };
  }
  const name = cleanText(input.client_name, "client_name", 120);
  if (typeof name !== "string") return { ok: false, reason: name.error };
  const suburb = cleanText(input.suburb, "suburb", 80);
  if (typeof suburb !== "string") return { ok: false, reason: suburb.error };
  let address: string | null = null;
  if (input.address != null && input.address !== "") {
    const cleaned = cleanText(input.address, "address", 500);
    if (typeof cleaned !== "string") {
      return { ok: false, reason: cleaned.error };
    }
    address = cleaned;
  }
  if (
    typeof input.arrival_start !== "string" ||
    typeof input.arrival_end !== "string" ||
    !ISO_WITH_OFFSET.test(input.arrival_start) ||
    !ISO_WITH_OFFSET.test(input.arrival_end)
  ) {
    return {
      ok: false,
      reason: "arrival window must be ISO datetimes with an explicit offset",
    };
  }
  const startMs = Date.parse(input.arrival_start);
  const endMs = Date.parse(input.arrival_end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, reason: "arrival window is not a real time" };
  }
  if (endMs <= startMs) {
    return { ok: false, reason: "arrival window end must follow its start" };
  }

  const body: Record<string, unknown> = {
    subject: `Scope: ${name}, ${suburb}`,
    start: { dateTime: perthLocal(startMs), timeZone: PERTH_TIMEZONE },
    end: { dateTime: perthLocal(endMs), timeZone: PERTH_TIMEZONE },
    showAs: "busy",
    isAllDay: false,
    responseRequested: false,
    attendees: [],
    body: {
      contentType: "text",
      content: `Arrival window ${perthClock(startMs)} to ${
        perthClock(endMs)
      }. Booked in GHL, appointment ${input.ghl_appointment_id}.`,
    },
    transactionId: outlookMirrorTransactionId(input.ghl_appointment_id),
    singleValueExtendedProperties: [
      {
        id: SALES_BOOKING_GHL_MIRROR_PROPERTY_ID,
        value: input.ghl_appointment_id,
      },
    ],
  };
  if (address) body.location = { displayName: address };
  return {
    ok: true,
    request: {
      method: "POST",
      path: `/users/${encodeURIComponent(mailbox)}/calendar/events`,
      body,
    },
  };
}

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/** Primary-calendar search for an event already carrying this GHL id. */
export function outlookMirrorLookupUrl(
  mailbox: string,
  ghlAppointmentId: string,
): string {
  const url = new URL(
    `${GRAPH_ROOT}/users/${encodeURIComponent(mailbox)}/calendar/events`,
  );
  // ghlAppointmentId is GHL_ID-validated, so it cannot break the quoting.
  url.searchParams.set(
    "$filter",
    `singleValueExtendedProperties/Any(ep: ep/id eq '${SALES_BOOKING_GHL_MIRROR_PROPERTY_ID}' and ep/value eq '${ghlAppointmentId}')`,
  );
  url.searchParams.set("$select", "id,subject,start,end");
  url.searchParams.set("$top", "5");
  return url.toString();
}

/**
 * Write the Outlook mirror of one GHL appointment. Default off; idempotent on
 * the GHL appointment id. Never throws.
 */
export async function writeOutlookMirrorEvent(
  input: OutlookMirrorInput,
  deps: OutlookMirrorDependencies,
): Promise<OutlookMirrorResult> {
  const built = buildOutlookMirrorRequest(input);
  if (!built.ok) {
    return {
      ok: false,
      code: "invalid_input",
      wrote: false,
      reason: built.reason,
    };
  }
  if (deps.env(SALES_BOOKING_OUTLOOK_MIRROR_FLAG) !== "true") {
    return {
      ok: false,
      code: "flag_off",
      dry_run: true,
      wrote: false,
      would_write: built.request,
    };
  }

  const mailbox = SALES_BOOKING_OUTLOOK_MAILBOXES[input.resource_id];
  const ghlId = input.ghl_appointment_id;
  let existing: OutlookMirrorGraphResponse;
  try {
    existing = await deps.graphGet(outlookMirrorLookupUrl(mailbox, ghlId));
  } catch (error) {
    return {
      ok: false,
      code: "mirror_lookup_failed",
      wrote: false,
      reason: (error as Error)?.message || "unknown",
    };
  }
  const found = existing.body as Record<string, unknown> | null;
  if (
    existing.status < 200 || existing.status >= 300 || !found ||
    !Array.isArray(found.value)
  ) {
    return {
      ok: false,
      code: "mirror_lookup_failed",
      wrote: false,
      reason: `outlook_lookup_http_${existing.status}`,
    };
  }
  const hit = found.value.find((row) =>
    row && typeof (row as Record<string, unknown>).id === "string"
  ) as Record<string, unknown> | undefined;
  if (hit) {
    return {
      ok: true,
      code: "already_mirrored",
      wrote: false,
      outlook_event_id: String(hit.id),
      ghl_appointment_id: ghlId,
    };
  }

  let created: OutlookMirrorGraphResponse;
  try {
    created = await deps.graphPost(
      `${GRAPH_ROOT}${built.request.path}`,
      built.request.body,
    );
  } catch (error) {
    return {
      ok: false,
      code: "mirror_outcome_unknown",
      wrote: false,
      reason: (error as Error)?.message || "unknown",
    };
  }
  const createdBody = created.body as Record<string, unknown> | null;
  if (created.status >= 500 || created.status === 429) {
    return {
      ok: false,
      code: "mirror_outcome_unknown",
      wrote: false,
      reason: `outlook_create_http_${created.status}`,
    };
  }
  if (
    created.status < 200 || created.status >= 300 || !createdBody ||
    typeof createdBody.id !== "string"
  ) {
    return {
      ok: false,
      code: "mirror_write_failed",
      wrote: false,
      reason: `outlook_create_http_${created.status}`,
    };
  }
  return {
    ok: true,
    code: "mirrored",
    wrote: true,
    outlook_event_id: createdBody.id,
    ghl_appointment_id: ghlId,
  };
}

async function graphJsonLive(
  url: string,
  init: RequestInit,
): Promise<OutlookMirrorGraphResponse> {
  let token = await getGraphToken();
  const res = await graphFetch(url, token, {
    init: { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) },
    refresh: async () => {
      token = await getGraphToken({ forceRefresh: true });
      return token;
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Production dependencies: the mail app's existing Graph app-only token. */
export function createOutlookMirrorDependencies(): OutlookMirrorDependencies {
  return {
    env: (name) => Deno.env.get(name),
    graphGet: (url) => graphJsonLive(url, { method: "GET" }),
    graphPost: (url, body) =>
      graphJsonLive(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

/** Executor entry point: mirror one just-written GHL appointment to Outlook. */
export async function mirrorGhlAppointmentToOutlook(
  input: OutlookMirrorInput,
): Promise<OutlookMirrorResult> {
  return await writeOutlookMirrorEvent(
    input,
    createOutlookMirrorDependencies(),
  );
}
