// ════════════════════════════════════════════════════════════
// SALES BOOKING READ — one bounded, honest read for the Sales Booking view
// ════════════════════════════════════════════════════════════
//
// `ops-api?action=sales_booking_read` serves the secureworks-ux Sales Booking
// view (`opsFetch('sales_booking_read', {resource, week_start, scoper_user_id})`).
// It replaces the branch-local preview server `scripts/sales-booking-local-api.mjs`
// with the same response shape, plus the two facts the browser must not derive
// itself: the scoper's GHL `diary[]` for the week, and per-case
// `thread_facts` so the queue can paint waiting-for-reply / offer-out without
// reading every GHL thread client-side.
//
// ── READ ONLY ──
// This module performs NO writes of any kind: no Supabase mutation, no GHL
// write, no calendar create, no send. Every dependency it takes is a reader.
// There is deliberately no draft store (the reference shape's `drafts` is
// always `{}`) because that would be a new table, which is out of scope.
//
// ── HONESTY CONTRACT (wiki skill `secureworks-scope-booking`) ──
//  1. Full population, or an explicit `coverage.full_population:false` naming
//     the gap. A bounded scan that did not reach the end is never an empty book.
//  2. Never invent a GHL or calendar fact. A sub-read that failed is reported
//     `read_ok:false` with a reason, on the row, and the row still appears.
//  3. Auto-ack and missed-call templates are NOT human replies
//     (`SALES_BOOKING_TEMPLATE_MARKERS`).
//  4. Unread leave is not free capacity: `coverage.operational_leave` stays
//     `not_read` because GHL appointments do not carry an Outlook-style leave
//     calendar. Missing coverage is never a free week.
//  5. Only people who need a visit, a reply or a quote. `scope_stage_ids`
//     drops quote-sent / won / hold / lost / archive. `coverage.enumerated`
//     is that scoped count; `excluded_by_stage` is how many open rows were
//     left out. CRM row count is not visit demand.
//
// A failure in any sub-read degrades that item, never the whole response. The
// action throws only on an invalid request (unknown resource / malformed week).
//
// ── SENDS AND CALENDAR WRITES ARE HELD ──
// `send_hold: true` and `policy.{activation,send,calendar_write} = 'held'` are
// constants here. This action has no capability to send or to write a calendar;
// the flags exist so the view can render the hold, not as the enforcement.

import {
  confirmGhlUserId,
  fetchGhlCalendarEvents,
  fetchGhlLocationUsers,
  type GhlCalendarGet,
} from "../ghl-proxy/calendar_events.ts";

export const SALES_BOOKING_API_VERSION = "sales-booking-api/v1";

/** Perth is UTC+8 year round (no daylight saving), so a fixed offset is exact. */
export const PERTH_UTC_OFFSET = "+08:00";
export const PERTH_TIMEZONE = "Australia/Perth";

/** Skill default: a human outbound less than this old with no reply since is
 * `waiting_reply`. Do not double-message inside it. */
export const SALES_BOOKING_QUIET_HOURS = 20;

/**
 * Bodies that are automation, not a person. An outbound matching one of these
 * never becomes `last_human_outbound_at`, never starts the quiet window, and
 * never counts as "we already answered". Compared against a lower-cased,
 * whitespace-collapsed body, so casing and line wrapping do not defeat them.
 */
export const SALES_BOOKING_TEMPLATE_MARKERS: readonly string[] = [
  "thanks for reaching out to secureworks",
  "sorry we missed your call",
];

/**
 * Captain defaults for v1 (2026-09-16). Published on every response so the
 * view renders what the server actually assumed and the Captain can flip them
 * without reading code. Flipping a default is a change here, not a UI change.
 */
export const SALES_BOOKING_CAPTAIN_DEFAULTS = {
  scopers: ["nithin", "marnin"] as const,
  scopes_done_window: "this_week_plus_last",
  sender_lines: { nithin: "774", marnin: "776" },
  stamp_board: "agent_driven_human_typed_later",
  recorded: "2026-09-16",
} as const;

export interface SalesBookingResource {
  resource_id: string;
  lane: "patio" | "fencing";
  /** GHL sales pipeline. Fencing and patio pipelines are never mixed. */
  pipeline_id: string;
  /** Application user UUID in `scoper_preferences`, not a Microsoft directory id. */
  scoper_user_id: string;
  /** Outbound SMS line for this resource. Captain default; see PR "Captain can flip tomorrow". */
  sender_line: string;
  sender_line_source: string;
  /**
   * GHL stages that still need a visit, a reply or a quote. Copied from wiki
   * https://github.com/SecureWorks-GROUP/secureworks-wiki/pull/438
   * (`pipeline_stages` on patio-nithin.json / fencing-stratco-marnin.json):
   * every stage before and including Scope Booked / visited-quote-to-send.
   * Quote-sent, won, hold, lost and archive stages stay off this door.
   */
  scope_stage_ids: readonly string[];
}

/**
 * Compatibility overlay for the live Booking door
 * (`secureworks-ux` `modules/ops-sales-booking.js`). That door paints
 * "Calendar not connected" only when `resource.calendar.ok === false`.
 * Values are copied from `diary_read`; this is not a second calendar read.
 */
export interface SalesBookingCalendarOverlay {
  ok: boolean;
  error: string | null;
  mailbox: string | null;
}

/**
 * v1 roster. `nithin` is the patio pipeline on line 774; `marnin` is the
 * fencing (Stratco) profile on line 776.
 *
 * The 776 value is the CAPTAIN'S RECORDED DEFAULT, not a guess: the UI doc
 * marks Marnin's line unresolved between 772 and 776 and forbids the browser
 * from choosing. The server states the decision and names where it came from.
 * Pipeline ids match `PRODUCTION_PIPELINES` in ghl-proxy; scoper ids match the
 * `secureworks-scope-booking` skill profiles.
 */
export const SALES_BOOKING_RESOURCES: Readonly<
  Record<string, SalesBookingResource>
> = {
  nithin: {
    resource_id: "nithin",
    lane: "patio",
    pipeline_id: "OGZLpPPVWVarN94HL6af",
    scoper_user_id: "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73",
    sender_line: "774",
    sender_line_source: "patio_profile_source_backed",
    // Wiki PR 438 patio-nithin.json pipeline_stages[0..4].
    scope_stage_ids: [
      "09759a42-f80a-4947-bca4-71df5dd770da", // Client Needs To Be Contacted
      "4d3bcf9a-185d-4a90-98e0-e0805fdf4a02", // Contacted Waiting on Response
      "637c165f-93a3-496b-8e86-970eb8935044", // Needs Scope / Quote
      "1c312cc2-b6f6-4aad-b3c0-a4b14784a5c5", // Scope Booked
      "9b9e5313-8e0e-4ed6-8654-d50413b99885", // Scope Complete / Quote to be Sent
    ],
  },
  marnin: {
    resource_id: "marnin",
    lane: "fencing",
    pipeline_id: "I9t8njpuR0Dm7B2NDcvI",
    scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498",
    sender_line: "776",
    sender_line_source: "captain_default_2026-09-16",
    // Wiki PR 438 fencing-stratco-marnin.json pipeline_stages[0..9].
    scope_stage_ids: [
      "cc401467-4743-4dbd-a7d7-e8f2ff023dd2", // New Lead (Call + Qualify)
      "7f863a14-1d9f-4a18-b73c-0e1780390bd7", // New Lead (Replied/ Contacted)
      "8c43212e-5e58-4f0d-b7f7-96c6ee644d6e", // Stale Lead
      "341d6a77-6a35-4338-b2b0-09236c7c80f9", // Called, No Answer
      "52c70bff-5cf3-447b-b891-03c30486aed8", // Call Answered (presentation not made)
      "6b101809-a4f9-440d-ac4c-0be669b8173e", // Presentation Made (scope not booked)
      "bfdba902-0a92-4a90-95a5-af27d7502a90", // Needs On Site Scope Urgently
      "09eeb872-fa46-41fc-a96b-8a8d2bc12215", // Lead Closed (scope booked)
      "4dc3da8f-d713-4bd4-851c-8e89b6682a4e", // Scope Scheduled
      "418534d4-6356-4c20-a274-51fbb892c2fa", // Scope Complete
    ],
  },
};

/**
 * GHL user ids are not stored anywhere in this backend: `users`,
 * `scoper_preferences` (google_calendar_id / work_calendar_email only), and
 * ghl-proxy config all lack a ghl_user_id. Do not embed a guessed id.
 *
 * Keyed by resource. Email source: `public.users.email` for the scoper_user_id
 * already on SALES_BOOKING_RESOURCES (Nithin patio, Marnin fencing Stratco;
 * confirmed by `20260322000005_fix_user_roles.sql` and the scoper_preferences
 * seed). The live GHL id is confirmed at read time against GET /users/?locationId=.
 * Khairo is intentionally absent.
 */
export const SALES_BOOKING_GHL_USERS: Readonly<
  Record<string, { email: string; ghl_user_id: string | null }>
> = {
  nithin: {
    email: "nithin@secureworkswa.com.au",
    ghl_user_id: null,
  },
  marnin: {
    email: "marnin@secureworkswa.com.au",
    ghl_user_id: null,
  },
};

// ── Bounds ───────────────────────────────────────────────────
// Every scan here is bounded. A bound that was HIT is reported as a gap, never
// swallowed: an unfinished scan must not read as a finished small board.
export const SALES_BOOKING_MAX_OPPORTUNITY_PAGES = 20;
export const SALES_BOOKING_OPPORTUNITY_PAGE_SIZE = 100;
/** Raised so a typical scope-needing set (tens of rows) is fully read. */
export const SALES_BOOKING_DEFAULT_THREAD_LIMIT = 200;
export const SALES_BOOKING_MAX_THREAD_LIMIT = 250;
export const SALES_BOOKING_THREAD_CONCURRENCY = 6;
export const SALES_BOOKING_DEFAULT_THREAD_BUDGET_MS = 18_000;

// ════════════════════════════════════════════════════════════
// Week window (pure)
// ════════════════════════════════════════════════════════════

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Monday of the Perth week containing `now`. ISO weekday 1..7 with Monday
 * first, computed on the Perth wall clock rather than the isolate's own zone.
 */
export function defaultPerthWeekStart(now: Date): string {
  // Shift into Perth wall time, then read the UTC parts of the shifted instant.
  const perth = new Date(now.getTime() + 8 * 3_600_000);
  const isoWeekday = perth.getUTCDay() === 0 ? 7 : perth.getUTCDay();
  const monday = new Date(perth.getTime() - (isoWeekday - 1) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

export interface SalesBookingWeekWindow {
  week_start: string;
  /** Inclusive lower bound, Monday 00:00 Perth. */
  since: string;
  /** Exclusive upper bound, the following Monday 00:00 Perth. */
  until_exclusive: string;
  timezone: string;
}

/**
 * Monday-to-Sunday Perth window for `week_start`. Throws on a malformed date or
 * a date that is not a Monday — a week grid anchored on the wrong day would
 * silently mis-place every diary block.
 */
export function perthWeekWindow(weekStart: string): SalesBookingWeekWindow {
  if (!ISO_DATE.test(weekStart)) {
    throw new Error(
      `week_start must be an ISO date (YYYY-MM-DD); got ${
        JSON.stringify(weekStart)
      }`,
    );
  }
  const startMs = Date.parse(`${weekStart}T00:00:00${PERTH_UTC_OFFSET}`);
  if (!Number.isFinite(startMs)) {
    throw new Error(`week_start is not a real date: ${weekStart}`);
  }
  // Round-trip guard: Date.parse accepts 2026-02-31 and rolls it forward.
  const perthDay = new Date(startMs + 8 * 3_600_000);
  if (perthDay.toISOString().slice(0, 10) !== weekStart) {
    throw new Error(`week_start is not a real date: ${weekStart}`);
  }
  if (perthDay.getUTCDay() !== 1) {
    throw new Error(
      `week_start must be a Monday (Australia/Perth); ${weekStart} is not`,
    );
  }
  const endMs = startMs + 7 * 86_400_000;
  return {
    week_start: weekStart,
    since: `${weekStart}T00:00:00${PERTH_UTC_OFFSET}`,
    until_exclusive: `${
      new Date(endMs + 8 * 3_600_000).toISOString().slice(0, 10)
    }T00:00:00${PERTH_UTC_OFFSET}`,
    timezone: PERTH_TIMEZONE,
  };
}

// ════════════════════════════════════════════════════════════
// Thread facts (pure)
// ════════════════════════════════════════════════════════════

export type SalesBookingClassification =
  | "ready_to_contact"
  | "waiting_reply"
  | "follow_up_due"
  | "needs_decision"
  | "unread";

export interface SalesBookingMessage {
  id?: string;
  type?: string;
  direction?: string;
  body?: string;
  timestamp?: string;
  userId?: string;
}

export interface SalesBookingThreadFacts {
  case_id: string;
  contact_id: string | null;
  read_ok: boolean;
  reason: string | null;
  last_inbound_at: string | null;
  last_human_outbound_at: string | null;
  /** Any outbound, template rows included. Never a substitute for the human one. */
  last_outbound_at: string | null;
  quiet_window: boolean;
  quiet_hours: number;
  classification: SalesBookingClassification;
  message_count: number;
  template_outbound_count: number;
}

function normaliseBody(body: unknown): string {
  return String(body ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when an outbound body is an auto-ack / missed-call template, not a person. */
export function isSalesBookingTemplateBody(body: unknown): boolean {
  const text = normaliseBody(body);
  if (!text) return false;
  return SALES_BOOKING_TEMPLATE_MARKERS.some((marker) => text.includes(marker));
}

function messageTimestamp(message: SalesBookingMessage): number | null {
  const raw = message.timestamp;
  if (raw === undefined || raw === null || raw === "") return null;
  const ms = typeof raw === "number" ? raw : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function messageDirection(
  message: SalesBookingMessage,
): "inbound" | "outbound" {
  const declared = String(message.direction || "").toLowerCase();
  if (declared === "inbound" || declared === "outbound") return declared;
  // Mirrors ghl-proxy get_conversation: a row carrying a userId was sent by us.
  return message.userId ? "outbound" : "inbound";
}

/**
 * A GHL activity/workflow row is neither a customer word nor a human reply.
 * Calls DO count as inbound contact (their words are never inferred).
 */
function messageCountsAsContact(message: SalesBookingMessage): boolean {
  const type = String(message.type || "").toUpperCase();
  return !type.includes("ACTIVITY") && !type.includes("WORKFLOW");
}

/**
 * Derive thread facts from an already-read message list.
 *
 * Pure: no clock of its own, no network. `nowMs` decides only the quiet window.
 * Classification never emits `booked` — a booking is a calendar/commitment fact
 * this function cannot see, and guessing one from chat text would invent it.
 */
export function deriveSalesBookingThreadFacts(args: {
  caseId: string;
  contactId: string | null;
  messages: SalesBookingMessage[];
  nowMs: number;
  quietHours?: number;
}): SalesBookingThreadFacts {
  const quietHours = args.quietHours ?? SALES_BOOKING_QUIET_HOURS;
  let lastInbound: number | null = null;
  let lastHumanOutbound: number | null = null;
  let lastOutbound: number | null = null;
  let templateOutbound = 0;
  let counted = 0;

  for (const message of args.messages) {
    if (!messageCountsAsContact(message)) continue;
    const at = messageTimestamp(message);
    if (at === null) continue;
    counted++;
    if (messageDirection(message) === "inbound") {
      if (lastInbound === null || at > lastInbound) lastInbound = at;
      continue;
    }
    if (lastOutbound === null || at > lastOutbound) lastOutbound = at;
    if (isSalesBookingTemplateBody(message.body)) {
      templateOutbound++;
      continue;
    }
    if (lastHumanOutbound === null || at > lastHumanOutbound) {
      lastHumanOutbound = at;
    }
  }

  const inboundIsLatest = lastInbound !== null &&
    (lastHumanOutbound === null || lastInbound > lastHumanOutbound);
  const quietWindow = lastHumanOutbound !== null && !inboundIsLatest &&
    args.nowMs - lastHumanOutbound < quietHours * 3_600_000;

  let classification: SalesBookingClassification;
  if (inboundIsLatest) classification = "needs_decision";
  else if (lastHumanOutbound !== null) {
    classification = quietWindow ? "waiting_reply" : "follow_up_due";
  } else classification = "ready_to_contact";

  const iso = (
    ms: number | null,
  ) => (ms === null ? null : new Date(ms).toISOString());
  return {
    case_id: args.caseId,
    contact_id: args.contactId,
    read_ok: true,
    reason: null,
    last_inbound_at: iso(lastInbound),
    last_human_outbound_at: iso(lastHumanOutbound),
    last_outbound_at: iso(lastOutbound),
    quiet_window: quietWindow,
    quiet_hours: quietHours,
    classification,
    message_count: counted,
    template_outbound_count: templateOutbound,
  };
}

/** An unread thread. The row still exists; it simply claims nothing. */
export function unreadSalesBookingThreadFacts(
  caseId: string,
  contactId: string | null,
  reason: string,
): SalesBookingThreadFacts {
  return {
    case_id: caseId,
    contact_id: contactId,
    read_ok: false,
    reason,
    last_inbound_at: null,
    last_human_outbound_at: null,
    last_outbound_at: null,
    quiet_window: false,
    quiet_hours: SALES_BOOKING_QUIET_HOURS,
    classification: "unread",
    message_count: 0,
    template_outbound_count: 0,
  };
}

// ════════════════════════════════════════════════════════════
// Cases (pure)
// ════════════════════════════════════════════════════════════

export interface SalesBookingCase {
  id: string;
  resource_id: string;
  opportunity_id: string;
  contact_id: string | null;
  suburb: string | null;
  display_name: string;
  status: string;
  tags: string[];
  /** Additive: GHL stage name when the pipeline stage map resolved it. */
  stage_name: string | null;
  /** Additive: newest GHL activity timestamp, used to order the thread budget. */
  last_activity_at: string | null;
}

/** A contact whose "name" is really a phone number is an unnamed enquiry. */
export function isPhoneLikeName(name: unknown): boolean {
  const text = String(name ?? "").replace(/\s/g, "");
  return /^(\+61|0)\d/.test(text);
}

/**
 * Project one raw GHL opportunity onto a case row. Never invents a suburb: an
 * absent contact city stays null so nothing downstream places a window on a
 * guessed locality.
 */
export function projectSalesBookingCase(
  opportunity: Record<string, unknown>,
  resourceId: string,
  stages: Record<string, string> = {},
): SalesBookingCase | null {
  const id = typeof opportunity.id === "string" ? opportunity.id : "";
  if (!id) return null;
  const contact =
    (opportunity.contact && typeof opportunity.contact === "object"
      ? opportunity.contact
      : {}) as Record<string, unknown>;
  const rawName = (typeof contact.name === "string" && contact.name) ||
    (typeof opportunity.name === "string" && opportunity.name) || "";
  const suburb = typeof contact.city === "string" && contact.city.trim()
    ? contact.city.trim()
    : null;
  const stageId = typeof opportunity.pipelineStageId === "string"
    ? opportunity.pipelineStageId
    : "";
  const updatedAt = [
    opportunity.updatedAt,
    opportunity.dateUpdated,
    opportunity.lastStatusChangeAt,
    opportunity.createdAt,
  ].find((value) => typeof value === "string" && value);
  return {
    id,
    resource_id: resourceId,
    opportunity_id: id,
    contact_id: (typeof contact.id === "string" && contact.id) ||
      (typeof opportunity.contactId === "string" && opportunity.contactId) ||
      null,
    suburb,
    display_name: isPhoneLikeName(rawName) ? "Enquiry" : (rawName || "Enquiry"),
    status: "needs_decision",
    tags: Array.isArray(contact.tags) ? contact.tags.map((t) => String(t)) : [],
    stage_name: (stageId && stages[stageId]) || null,
    last_activity_at: typeof updatedAt === "string" ? updatedAt : null,
  };
}

/**
 * True when the opportunity is still in a stage that needs a visit, a reply
 * or a quote. Unknown or blank stage ids are out of scope (never the whole CRM).
 */
export function isSalesBookingScopeStage(
  stageId: string | null | undefined,
  scopeStageIds: readonly string[],
): boolean {
  return typeof stageId === "string" && stageId.length > 0 &&
    scopeStageIds.includes(stageId);
}

// ════════════════════════════════════════════════════════════
// Diary (pure)
// ════════════════════════════════════════════════════════════

export type SalesBookingDiaryKind = "busy" | "leave" | "personal";

export interface SalesBookingDiaryEntry {
  event_id: string;
  start: string;
  end: string;
  title: string | null;
  kind: SalesBookingDiaryKind;
  source: string;
  /** Raw GHL `appointmentStatus`. */
  show_as: string | null;
  /** False for cancelled: on the diary, but not occupancy. */
  blocks_capacity: boolean;
  is_all_day: boolean;
  location: string | null;
  /** Always false on the GHL path: GHL appointments have no private-sensitivity flag. */
  title_withheld: boolean;
}

const DIARY_SOURCE = "ghl_calendar";

/**
 * Stamp a Perth offset on an offset-less local datetime. GHL usually already
 * sends an offset; Unix milliseconds and date-only all-day values are accepted
 * too. Named `perthGraphInstant` in the 16 Sep Outlook reader; kept as a
 * compatibility export so older tests that only care about ISO stamping still
 * compile against this module.
 */
export function perthDiaryInstant(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== "string" || !value) return null;
  const trimmed = value.replace(/\.\d+$/, "");
  if (/^\d{10,13}$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const withOffset = `${trimmed}T00:00:00${PERTH_UTC_OFFSET}`;
    return Number.isFinite(Date.parse(withOffset)) ? withOffset : null;
  }
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) return null;
  const withOffset = `${trimmed}${PERTH_UTC_OFFSET}`;
  return Number.isFinite(Date.parse(withOffset)) ? withOffset : null;
}

/** @deprecated Use perthDiaryInstant. Outlook Graph is no longer the diary source. */
export const perthGraphInstant = perthDiaryInstant;

/**
 * Project one GHL calendar event onto a diary entry.
 *
 * `kind` and `blocks_capacity` come from provider status only, never from
 * title text. Confirmed/booked (and the conservative occupied statuses) block;
 * cancelled does not block but still appears with `show_as:'cancelled'`.
 * GHL has no leave/personal sensitivity, so those kinds are not invented.
 * Returns null for a malformed event; the caller counts the drop.
 */
export function projectSalesBookingDiaryEntry(
  event: Record<string, unknown>,
): SalesBookingDiaryEntry | null {
  const id = typeof event.id === "string" ? event.id : "";
  const start = perthDiaryInstant(event.startTime);
  const end = perthDiaryInstant(event.endTime);
  if (!id || !start || !end) return null;

  const rawStatus = typeof event.appointmentStatus === "string"
    ? event.appointmentStatus
    : null;
  const status = (rawStatus || "").toLowerCase();
  const cancelled = status === "cancelled";
  const showAs = cancelled ? "cancelled" : (rawStatus || "busy");
  // Conservative: only cancelled is non-occupancy. Unknown statuses still block.
  const title = typeof event.title === "string" && event.title
    ? event.title
    : null;
  const location = typeof event.address === "string" && event.address
    ? event.address
    : null;
  return {
    event_id: id,
    start,
    end,
    title,
    kind: "busy",
    source: DIARY_SOURCE,
    show_as: showAs,
    blocks_capacity: !cancelled,
    is_all_day: event.isAllDay === true,
    location,
    title_withheld: false,
  };
}

/**
 * Pick the GHL mapping for this calendar read. `scoper_user_id` may override
 * the resource the same way it used to override the Outlook mailbox: only a
 * known v1 scoper (Nithin / Marnin) maps. Anyone else is unmapped — never a
 * guess, never Khairo.
 */
export function resolveSalesBookingGhlMapping(
  resourceId: string,
  scoperUserId: string,
): { resource_id: string; email: string; ghl_user_id: string | null } | null {
  const byScoper = Object.values(SALES_BOOKING_RESOURCES).find((row) =>
    row.scoper_user_id === scoperUserId
  );
  const key = byScoper?.resource_id || resourceId;
  const mapping = SALES_BOOKING_GHL_USERS[key];
  if (!mapping) return null;
  if (byScoper) {
    return {
      resource_id: byScoper.resource_id,
      email: mapping.email,
      ghl_user_id: mapping.ghl_user_id,
    };
  }
  if (SALES_BOOKING_RESOURCES[resourceId]?.scoper_user_id === scoperUserId) {
    return {
      resource_id: resourceId,
      email: mapping.email,
      ghl_user_id: mapping.ghl_user_id,
    };
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// Assembly (pure)
// ════════════════════════════════════════════════════════════

export interface SalesBookingOpportunityScan {
  opportunities: Record<string, unknown>[];
  stages: Record<string, string>;
  /** True only when the scan reached the real end of the result set. */
  exhausted: boolean;
  pages_scanned: number;
  total: number | null;
  /** Non-null when the roster read failed or stopped short. */
  reason: string | null;
}

export interface SalesBookingDiaryScan {
  read_ok: boolean;
  reason: string | null;
  entries: SalesBookingDiaryEntry[];
  malformed_dropped: number;
  calendar_email: string | null;
  ghl_user_id: string | null;
  scoper_user_id: string | null;
}

export interface SalesBookingThreadScan {
  facts: Record<string, SalesBookingThreadFacts>;
  attempted: number;
  read_ok_count: number;
  /** Cases that were never attempted because a bound was hit. */
  not_attempted: number;
  budget_exhausted: boolean;
  enabled: boolean;
}

export interface SalesBookingReadResponse {
  ok: true;
  fixture: false;
  send_hold: true;
  version: string;
  week_start: string;
  week: SalesBookingWeekWindow;
  resource: SalesBookingResource & { calendar: SalesBookingCalendarOverlay };
  coverage: {
    full_population: boolean;
    enumerated: number;
    total: number | null;
    /** Open roster rows left out because their GHL stage is past scope-needed. */
    excluded_by_stage: number;
    operational_leave: "not_read";
    gaps: string[];
    pages_scanned: number;
    threads_read: number;
    threads_attempted: number;
    diary_read_ok: boolean;
  };
  cases: SalesBookingCase[];
  diary: SalesBookingDiaryEntry[];
  diary_read: {
    read_ok: boolean;
    reason: string | null;
    source: string;
    calendar_email: string | null;
    ghl_user_id: string | null;
  };
  thread_facts: Record<string, SalesBookingThreadFacts>;
  drafts: Record<string, never>;
  defaults: typeof SALES_BOOKING_CAPTAIN_DEFAULTS;
  policy: { activation: "held"; send: "held"; calendar_write: "held" };
}

/**
 * Compose the response from three already-run scans. Pure, so the whole shape
 * and every coverage sentence is unit-testable without a network.
 */
export function assembleSalesBookingRead(input: {
  resource: SalesBookingResource;
  week: SalesBookingWeekWindow;
  /** Already de-duplicated, stage-scoped and projected. */
  projectedCases: SalesBookingCase[];
  opportunities: SalesBookingOpportunityScan;
  diary: SalesBookingDiaryScan;
  threads: SalesBookingThreadScan;
  /** Unique open rows dropped because their stage is past scope-needed. */
  excludedByStage?: number;
}): SalesBookingReadResponse {
  const { resource, week, opportunities, diary, threads } = input;
  const cases = input.projectedCases;

  const gaps: string[] = [];
  gaps.push(
    opportunities.exhausted
      ? "Opportunity enumeration terminal for this resource."
      : "Opportunity enumeration did not reach the end of the result set; this is not a completed empty book.",
  );
  if (opportunities.reason) {
    gaps.push(`Opportunity roster read degraded: ${opportunities.reason}`);
  }
  gaps.push(
    diary.read_ok
      ? "GHL calendar read for this week. Operational leave, travel and non-GHL calendars remain unread. Missing coverage is not free capacity."
      : `Scoper calendar unread (${
        diary.reason || "unknown"
      }). Missing coverage is not free capacity.`,
  );
  if (diary.malformed_dropped > 0) {
    gaps.push(
      `${diary.malformed_dropped} calendar event(s) were dropped as malformed and are not represented in the diary.`,
    );
  }
  if (!threads.enabled) {
    gaps.push(
      "Thread facts were not requested; no case carries a proved conversation state.",
    );
  } else {
    const unread = threads.attempted - threads.read_ok_count;
    if (threads.not_attempted > 0) {
      gaps.push(
        `${threads.not_attempted} case(s) had no thread read${
          threads.budget_exhausted
            ? " (time budget exhausted)"
            : " (row budget reached)"
        }; their status is unproved, not clear.`,
      );
    }
    if (unread > 0) {
      gaps.push(
        `${unread} thread read(s) failed; those cases stay on the board as unread.`,
      );
    }
  }

  return {
    ok: true,
    fixture: false,
    send_hold: true,
    version: SALES_BOOKING_API_VERSION,
    week_start: week.week_start,
    week,
    resource: {
      ...resource,
      calendar: {
        ok: diary.read_ok,
        error: diary.read_ok ? null : diary.reason,
        mailbox: diary.calendar_email,
      },
    },
    coverage: {
      // Full population means the roster was terminal. Thread and calendar gaps
      // are named separately: they narrow what is KNOWN about a case, not
      // whether the book is complete. `enumerated` is the scoped count, not
      // the whole CRM.
      full_population: opportunities.exhausted && !opportunities.reason,
      enumerated: cases.length,
      total: opportunities.total,
      excluded_by_stage: input.excludedByStage ?? 0,
      operational_leave: "not_read",
      gaps,
      pages_scanned: opportunities.pages_scanned,
      threads_read: threads.read_ok_count,
      threads_attempted: threads.attempted,
      diary_read_ok: diary.read_ok,
    },
    cases,
    diary: diary.entries,
    diary_read: {
      read_ok: diary.read_ok,
      reason: diary.reason,
      source: DIARY_SOURCE,
      calendar_email: diary.calendar_email,
      ghl_user_id: diary.ghl_user_id,
    },
    thread_facts: threads.facts,
    // No draft store exists server-side (a new table is out of scope for v1).
    drafts: {},
    defaults: SALES_BOOKING_CAPTAIN_DEFAULTS,
    policy: { activation: "held", send: "held", calendar_write: "held" },
  };
}

// ════════════════════════════════════════════════════════════
// Runner + dependencies
// ════════════════════════════════════════════════════════════

export interface SalesBookingReadParams {
  resource?: string | null;
  week_start?: string | null;
  scoper_user_id?: string | null;
  include_thread_facts?: boolean;
  thread_limit?: number;
  thread_budget_ms?: number;
  case_ids?: string[] | null;
}

export interface SalesBookingReadDependencies {
  /** Bounded, terminal-or-honest GHL opportunity roster for one pipeline. */
  readOpportunities(
    args: { pipelineId: string },
  ): Promise<SalesBookingOpportunityScan>;
  /** One scoper's GHL calendar events for the week. Never throws. */
  readDiary(args: {
    resourceId: string;
    scoperUserId: string;
    since: string;
    untilExclusive: string;
  }): Promise<SalesBookingDiaryScan>;
  /** One contact's GHL conversation messages. Rejects on a failed read. */
  readThread(args: { contactId: string }): Promise<SalesBookingMessage[]>;
  now(): Date;
}

export class SalesBookingRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SalesBookingRequestError";
  }
}

export function resolveSalesBookingResource(
  resource: unknown,
): SalesBookingResource {
  const key = String(resource ?? "nithin").trim().toLowerCase();
  const found = SALES_BOOKING_RESOURCES[key];
  if (!found) {
    throw new SalesBookingRequestError(
      `Unknown resource ${JSON.stringify(resource)}. Use: ${
        Object.keys(SALES_BOOKING_RESOURCES).join(", ")
      }`,
    );
  }
  return found;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * Read threads for the selected cases under BOTH a row cap and a wall-clock
 * budget, at bounded concurrency. Cases beyond either bound are reported as
 * not attempted rather than silently omitted, so the view can tell "no reply
 * needed" from "nobody looked".
 */
async function scanThreads(
  deps: SalesBookingReadDependencies,
  cases: SalesBookingCase[],
  params: SalesBookingReadParams,
): Promise<SalesBookingThreadScan> {
  const enabled = params.include_thread_facts !== false;
  const facts: Record<string, SalesBookingThreadFacts> = {};
  if (!enabled || cases.length === 0) {
    return {
      facts,
      attempted: 0,
      read_ok_count: 0,
      not_attempted: enabled ? cases.length : 0,
      budget_exhausted: false,
      enabled,
    };
  }

  const limit = clampInt(
    params.thread_limit,
    SALES_BOOKING_DEFAULT_THREAD_LIMIT,
    0,
    SALES_BOOKING_MAX_THREAD_LIMIT,
  );
  const budgetMs = clampInt(
    params.thread_budget_ms,
    SALES_BOOKING_DEFAULT_THREAD_BUDGET_MS,
    1_000,
    60_000,
  );
  const wanted = params.case_ids && params.case_ids.length
    ? new Set(params.case_ids.map((id) => String(id)))
    : null;

  // Newest activity first: the budget should be spent on the live end of the board.
  const ordered = cases
    .filter((row) => (wanted ? wanted.has(row.id) : true))
    .slice()
    .sort((a, b) =>
      Date.parse(b.last_activity_at || "") -
        Date.parse(a.last_activity_at || "") || a.id.localeCompare(b.id)
    );
  const selected = ordered.slice(0, limit);

  const startedAt = deps.now().getTime();
  let budgetExhausted = false;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= selected.length) return;
      if (deps.now().getTime() - startedAt >= budgetMs) {
        budgetExhausted = true;
        return;
      }
      const row = selected[index];
      if (!row.contact_id) {
        facts[row.id] = unreadSalesBookingThreadFacts(
          row.id,
          null,
          "no_ghl_contact_on_opportunity",
        );
        continue;
      }
      try {
        const messages = await deps.readThread({ contactId: row.contact_id });
        facts[row.id] = deriveSalesBookingThreadFacts({
          caseId: row.id,
          contactId: row.contact_id,
          messages,
          nowMs: deps.now().getTime(),
        });
      } catch (error) {
        facts[row.id] = unreadSalesBookingThreadFacts(
          row.id,
          row.contact_id,
          `ghl_thread_unread: ${(error as Error)?.message || "unknown"}`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({
      length: Math.min(SALES_BOOKING_THREAD_CONCURRENCY, selected.length),
    }, () => worker()),
  );

  const attempted = Object.keys(facts).length;
  const readOk = Object.values(facts).filter((f) => f.read_ok).length;
  return {
    facts,
    attempted,
    read_ok_count: readOk,
    not_attempted: Math.max(
      0,
      (wanted ? ordered.length : cases.length) - attempted,
    ),
    budget_exhausted: budgetExhausted,
    enabled,
  };
}

/**
 * Run one sales booking read.
 *
 * Throws only for an invalid request (unknown resource, malformed week_start).
 * Every DATA failure degrades its own item and is named in `coverage.gaps`.
 */
export async function salesBookingRead(
  deps: SalesBookingReadDependencies,
  params: SalesBookingReadParams,
): Promise<SalesBookingReadResponse> {
  const resource = resolveSalesBookingResource(params.resource);
  const weekStart = params.week_start && String(params.week_start).trim()
    ? String(params.week_start).trim()
    : defaultPerthWeekStart(deps.now());
  let week: SalesBookingWeekWindow;
  try {
    week = perthWeekWindow(weekStart);
  } catch (error) {
    throw new SalesBookingRequestError((error as Error).message);
  }

  const scoperUserId =
    params.scoper_user_id && String(params.scoper_user_id).trim()
      ? String(params.scoper_user_id).trim()
      : resource.scoper_user_id;

  const [opportunities, diary] = await Promise.all([
    deps.readOpportunities({ pipelineId: resource.pipeline_id }),
    deps.readDiary({
      resourceId: resource.resource_id,
      scoperUserId,
      since: week.since,
      untilExclusive: week.until_exclusive,
    }),
  ]);

  const projected: SalesBookingCase[] = [];
  const seen = new Set<string>();
  let excludedByStage = 0;
  for (const raw of opportunities.opportunities) {
    const row = projectSalesBookingCase(
      raw,
      resource.resource_id,
      opportunities.stages,
    );
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const stageId = typeof raw.pipelineStageId === "string"
      ? raw.pipelineStageId
      : "";
    if (!isSalesBookingScopeStage(stageId, resource.scope_stage_ids)) {
      excludedByStage++;
      continue;
    }
    projected.push(row);
  }

  const threads = await scanThreads(deps, projected, params);
  return assembleSalesBookingRead({
    resource,
    week,
    projectedCases: projected,
    opportunities,
    diary,
    threads,
    excludedByStage,
  });
}

// ── Production wiring ────────────────────────────────────────

const GHL_BASE = "https://services.leadconnectorhq.com";

async function ghlRead(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const token = Deno.env.get("GHL_API_TOKEN") || "";
  if (!token) throw new Error("GHL API token not configured");
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * Page `/opportunities/search` to a terminal page for one pipeline, exactly as
 * ghl-proxy's `fetchOpportunityPages` does: a SHORT page or an empty page is
 * the only positive proof the result set ended, and a stalled cursor stops the
 * scan with `exhausted:false` so a caller fails closed on an absence.
 *
 * GHL v3 search accepts a single `pipelineStageId`. This door needs several
 * (patio 5, fencing 10), so the live call stays `pipelineId` + `status=open`
 * and `salesBookingRead` filters to `scope_stage_ids` before the thread pass.
 */
async function readOpportunitiesLive(
  pipelineId: string,
): Promise<SalesBookingOpportunityScan> {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  const limit = SALES_BOOKING_OPPORTUNITY_PAGE_SIZE;
  const opportunities: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let startAfter: string | number | null = null;
  let startAfterId: string | null = null;
  let pages = 0;
  let total: number | null = null;
  let exhausted = false;
  let reason: string | null = null;

  try {
    for (let page = 1; page <= SALES_BOOKING_MAX_OPPORTUNITY_PAGES; page++) {
      const query = new URLSearchParams({
        locationId,
        limit: String(limit),
        pipelineId,
        status: "open",
      });
      if (startAfter != null) query.set("startAfter", String(startAfter));
      if (startAfterId) query.set("startAfterId", startAfterId);
      const data = await ghlRead(`/opportunities/search?${query.toString()}`, {
        headers: { Version: "v3" },
      });
      const rows = Array.isArray(data.opportunities)
        ? data.opportunities as Record<string, unknown>[]
        : [];
      const meta =
        (data.meta && typeof data.meta === "object" ? data.meta : {}) as Record<
          string,
          unknown
        >;
      pages++;
      if (typeof meta.total === "number") total = meta.total;
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      let fresh = 0;
      for (const row of rows) {
        const id = typeof row.id === "string" ? row.id : "";
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        opportunities.push(row);
        fresh++;
      }
      if (rows.length < limit) {
        exhausted = true;
        break;
      }
      const last = rows[rows.length - 1] as Record<string, unknown>;
      const sort = Array.isArray(last?.sort) ? last.sort : [];
      const nextAfter = meta.startAfter ?? sort[0] ?? null;
      const nextAfterId = meta.startAfterId ?? sort[1] ?? last?.contactId ??
        null;
      if (fresh === 0 || nextAfter == null || nextAfterId == null) break;
      startAfter = nextAfter as string | number;
      startAfterId = String(nextAfterId);
    }
    if (!exhausted && pages >= SALES_BOOKING_MAX_OPPORTUNITY_PAGES) {
      reason = `page cap ${SALES_BOOKING_MAX_OPPORTUNITY_PAGES} reached`;
    }
  } catch (error) {
    reason = (error as Error)?.message || "opportunity search failed";
  }

  let stages: Record<string, string> = {};
  try {
    const data = await ghlRead(
      `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
    );
    const pipelines = Array.isArray(data.pipelines)
      ? data.pipelines as Record<string, unknown>[]
      : [];
    for (const pipeline of pipelines) {
      if (pipeline.id !== pipelineId) continue;
      const list = Array.isArray(pipeline.stages)
        ? pipeline.stages as Record<string, unknown>[]
        : [];
      stages = Object.fromEntries(
        list.filter((s) => typeof s.id === "string").map((
          s,
        ) => [String(s.id), String(s.name ?? "")]),
      );
    }
  } catch {
    // Stage names are presentation only; an unread stage map leaves stage_name
    // null rather than degrading the roster.
    stages = {};
  }

  return {
    opportunities,
    stages,
    exhausted,
    pages_scanned: pages,
    total,
    reason,
  };
}

function conversationsFromGhlBody(
  body: Record<string, unknown> | unknown[],
): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (
    body && typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).conversations)
  ) {
    return (body as Record<string, unknown>).conversations as Record<
      string,
      unknown
    >[];
  }
  return [];
}

function messagesFromGhlBody(
  result: Record<string, unknown>,
): SalesBookingMessage[] {
  const nested = result.messages && typeof result.messages === "object"
    ? (result.messages as Record<string, unknown>).messages
    : null;
  const raw = Array.isArray(result.messages)
    ? result.messages
    : Array.isArray(nested)
    ? nested
    : Array.isArray(result.data)
    ? result.data
    : [];
  return (raw as Record<string, unknown>[]).map((m) => ({
    id: typeof m.id === "string" ? m.id : undefined,
    type: String(m.messageType || m.type || "SMS").toUpperCase(),
    direction: typeof m.direction === "string" ? m.direction : undefined,
    body: String(m.body || m.message || m.text || ""),
    timestamp: String(m.dateAdded || m.createdAt || m.timestamp || ""),
    userId: typeof m.userId === "string" ? m.userId : undefined,
  }));
}

/**
 * One contact's conversation messages, same two-step and same shape tolerance
 * as ghl-proxy `get_conversation`: conversation search, then the contact list
 * when search returns 200 with no rows, then messages. Empty search is not
 * proof of no thread (offer-out SMS conversations are omitted there). A
 * genuine miss on both lookups is an empty thread. A read failure REJECTS so
 * the caller records `read_ok:false` rather than an empty (and therefore
 * falsely quiet) thread.
 */
export async function readSalesBookingThreadMessages(
  ghlGet: (path: string) => Promise<Record<string, unknown>>,
  contactId: string,
  locationId: string,
): Promise<SalesBookingMessage[]> {
  const contactQuery = `contactId=${encodeURIComponent(contactId)}&locationId=${
    encodeURIComponent(locationId)
  }`;
  const search = await ghlGet(`/conversations/search?${contactQuery}`);
  let conversations = conversationsFromGhlBody(search);
  if (conversations.length === 0) {
    const direct = await ghlGet(`/conversations?${contactQuery}`);
    conversations = conversationsFromGhlBody(direct);
  }
  if (conversations.length === 0) return [];
  const conversationId = String(conversations[0].id || "");
  if (!conversationId) return [];
  const result = await ghlGet(
    `/conversations/${
      encodeURIComponent(conversationId)
    }/messages?limit=30&type=TYPE_SMS,TYPE_EMAIL,TYPE_CALL&sort=desc&sortBy=dateAdded`,
  );
  return messagesFromGhlBody(result);
}

async function readThreadLive(
  contactId: string,
): Promise<SalesBookingMessage[]> {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  return await readSalesBookingThreadMessages(ghlRead, contactId, locationId);
}

// Supabase query builders are thenables; this SELECT-only surface avoids
// coupling a read to service-role mutation capabilities. The GHL diary no
// longer reads scoper_preferences; the client stays on the factory so the
// dispatch signature is unchanged.
// deno-lint-ignore no-explicit-any
type SalesBookingReadClient = { from: (table: string) => any };

function unreadDiary(
  scoperUserId: string,
  reason: string,
  extra: { calendar_email?: string | null; ghl_user_id?: string | null } = {},
): SalesBookingDiaryScan {
  return {
    read_ok: false,
    reason,
    entries: [],
    malformed_dropped: 0,
    calendar_email: extra.calendar_email ?? null,
    ghl_user_id: extra.ghl_user_id ?? null,
    scoper_user_id: scoperUserId,
  };
}

/**
 * The scoper's GHL calendar for the window.
 *
 * GHL user ids are not in this backend. Resolve the resource's mapped email
 * against GET /users/?locationId=; unconfirmed is `ghl_user_unmapped`, never
 * an invented id and never an empty free week. A failed unpaged events GET
 * is `ghl_calendar_page_failed` with zero entries. Never throws.
 */
export async function readSalesBookingGhlDiary(args: {
  ghlGet: GhlCalendarGet;
  locationId: string;
  resourceId: string;
  scoperUserId: string;
  since: string;
  untilExclusive: string;
}): Promise<SalesBookingDiaryScan> {
  const mapping = resolveSalesBookingGhlMapping(
    args.resourceId,
    args.scoperUserId,
  );
  if (!mapping) {
    return unreadDiary(args.scoperUserId, "ghl_user_unmapped");
  }

  const users = await fetchGhlLocationUsers({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
  });
  if (users.failure) {
    return unreadDiary(args.scoperUserId, users.failure, {
      calendar_email: mapping.email,
    });
  }
  const confirmed = confirmGhlUserId({
    users: users.users,
    email: mapping.email,
    claimedId: mapping.ghl_user_id,
  });
  if (!confirmed.id) {
    return unreadDiary(
      args.scoperUserId,
      confirmed.reason || "ghl_user_unmapped",
      { calendar_email: mapping.email },
    );
  }

  const startMs = Date.parse(args.since);
  const untilMs = Date.parse(args.untilExclusive);
  if (
    !Number.isFinite(startMs) || !Number.isFinite(untilMs) || untilMs <= startMs
  ) {
    return unreadDiary(args.scoperUserId, "ghl_calendar_window_invalid", {
      calendar_email: mapping.email,
      ghl_user_id: confirmed.id,
    });
  }

  const scan = await fetchGhlCalendarEvents({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
    userId: confirmed.id,
    startMs,
    endMs: untilMs - 1,
  });
  if (scan.failure) {
    return unreadDiary(
      args.scoperUserId,
      scan.failure,
      { calendar_email: mapping.email, ghl_user_id: confirmed.id },
    );
  }

  const entries: SalesBookingDiaryEntry[] = [];
  let dropped = 0;
  for (const item of scan.events) {
    const entry = projectSalesBookingDiaryEntry(item);
    if (entry) entries.push(entry);
    else dropped++;
  }
  entries.sort((a, b) =>
    Date.parse(a.start) - Date.parse(b.start) ||
    a.event_id.localeCompare(b.event_id)
  );
  return {
    read_ok: true,
    reason: null,
    entries,
    malformed_dropped: dropped,
    calendar_email: mapping.email,
    ghl_user_id: confirmed.id,
    scoper_user_id: args.scoperUserId,
  };
}

async function readDiaryLive(
  resourceId: string,
  scoperUserId: string,
  since: string,
  untilExclusive: string,
): Promise<SalesBookingDiaryScan> {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  return await readSalesBookingGhlDiary({
    ghlGet: ghlRead,
    locationId,
    resourceId,
    scoperUserId,
    since,
    untilExclusive,
  });
}

/** Real readers for the dispatch. Every one is read-only. */
export function createSalesBookingReadDependencies(
  _client: SalesBookingReadClient,
): SalesBookingReadDependencies {
  return {
    readOpportunities: ({ pipelineId }) => readOpportunitiesLive(pipelineId),
    readDiary: ({ resourceId, scoperUserId, since, untilExclusive }) =>
      readDiaryLive(resourceId, scoperUserId, since, untilExclusive),
    readThread: ({ contactId }) => readThreadLive(contactId),
    now: () => new Date(),
  };
}

/** Dispatch entry point: parse the request, run the read, return the payload. */
export async function salesBookingReadAction(
  client: SalesBookingReadClient,
  params: SalesBookingReadParams,
): Promise<SalesBookingReadResponse> {
  return await salesBookingRead(
    createSalesBookingReadDependencies(client),
    params,
  );
}
