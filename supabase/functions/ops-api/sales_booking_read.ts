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
// ── NO SEND, NO GHL WRITE ──
// Page load may persist `sales_booking_packs` kind=thread_facts and kind=roster
// so the next read can serve cached conversation state and the opportunity
// enumeration. Those are the only writes. No GHL mutation, no calendar
// create, no send. Drafts and proposed windows come from the latest
// kind=pack row, merged in after this read.
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
  type GhlLocationUser,
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
   * In-scope GHL stage ids for this door. Copied from wiki
   * `secureworks-scope-booking` profiles (`pipeline_stages`). Rule:
   * `docs/sales-booking-read-contract-2026-09-16.md`.
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
    // patio-nithin.json visit/reply/quote: waiting on a reply, needs a visit,
    // scope booked, quote to send. Dropped Client Needs To Be Contacted
    // (09759a42-…) — 193 of 300 live Nithin rows on 17 Sep, first-touch sales.
    scope_stage_ids: [
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
    // fencing-stratco-marnin.json visit/reply/quote: replied, presentation,
    // urgent visit, booked, scheduled, quote to send. Dropped:
    // New Lead Call+Qualify (cc401467-…, first-touch), Stale Lead
    // (8c43212e-…, ghl-proxy maps to cancelled), Called No Answer
    // (341d6a77-…, call-qualify holding pen).
    scope_stage_ids: [
      "7f863a14-1d9f-4a18-b73c-0e1780390bd7", // New Lead (Replied/ Contacted)
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
 * GHL user ids are not stored on `users`, `scoper_preferences`, or ghl-proxy
 * config. Do not embed a guessed id. Nithin's pin stays null until the live
 * roster email is known. Confirmation (email, then unique name):
 * `docs/sales-booking-read-contract-2026-09-16.md`.
 */
export const SALES_BOOKING_GHL_USERS: Readonly<
  Record<string, {
    email: string;
    email_source: string;
    name_match: string | null;
    ghl_user_id: string | null;
  }>
> = {
  nithin: {
    email: "nithin@secureworkswa.com.au",
    email_source:
      "public.users.email (20260322000005_fix_user_roles.sql) and wiki patio-nithin.json calendar_email",
    name_match: "nithin",
    // Pin is a follow-up once the live roster email is known.
    ghl_user_id: null,
  },
  marnin: {
    email: "marnin@secureworkswa.com.au",
    email_source:
      "public.users.email (20260322000005_fix_user_roles.sql) and wiki fencing-stratco-marnin.json calendar_email",
    name_match: "marnin",
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
/** Whole-read wall clock covering roster paging, diary, contacts, and threads. */
export const SALES_BOOKING_READ_BUDGET_MS = 25_000;
export const SALES_BOOKING_THREAD_CACHE_MAX_AGE_MS = 6 * 3_600_000;
export const SALES_BOOKING_ROSTER_CACHE_MAX_AGE_MS = 10 * 60_000;
/** 1 attempt + 2 retries. Never more, even if a caller asks. */
export const SALES_BOOKING_GHL_429_TRIES = 3;
export const SALES_BOOKING_GHL_429_BASE_MS = 200;
export const SALES_BOOKING_NOT_GIVEN = "not given";
export const SALES_BOOKING_THREAD_FACTS_KIND = "thread_facts";
export const SALES_BOOKING_ROSTER_KIND = "roster";
/** Sentinel Monday so thread_facts and roster reuse the packs table without a week grid. */
export const SALES_BOOKING_THREAD_FACTS_WEEK_START = "1970-01-05";

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
  /** When these facts were last derived from a live GHL thread read. */
  read_at: string | null;
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
    read_at: new Date(args.nowMs).toISOString(),
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
    read_at: null,
  };
}

export type SalesBookingCachedThreadFact = SalesBookingThreadFacts & {
  read_at: string;
};

/** Cached facts are usable when last GHL activity is not newer than read_at and the cache is under 6 hours old. */
export function salesBookingThreadFactIsFresh(args: {
  cachedReadAt: string | null | undefined;
  lastActivityAt: string | null | undefined;
  nowMs: number;
  maxAgeMs?: number;
}): boolean {
  const readAtMs = Date.parse(String(args.cachedReadAt || ""));
  if (!Number.isFinite(readAtMs)) return false;
  const maxAge = args.maxAgeMs ?? SALES_BOOKING_THREAD_CACHE_MAX_AGE_MS;
  if (args.nowMs - readAtMs >= maxAge) return false;
  if (!args.lastActivityAt) return true;
  const activityMs = Date.parse(args.lastActivityAt);
  if (!Number.isFinite(activityMs)) return true;
  return activityMs <= readAtMs;
}

export function parseSalesBookingThreadFactsCache(
  payload: unknown,
): Record<string, SalesBookingCachedThreadFact> {
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const factsRaw = body.facts && typeof body.facts === "object" &&
      !Array.isArray(body.facts)
    ? body.facts as Record<string, unknown>
    : {};
  const out: Record<string, SalesBookingCachedThreadFact> = {};
  for (const [id, value] of Object.entries(factsRaw)) {
    if (!id || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const row = value as Record<string, unknown>;
    const readAt = nonemptyText(row.read_at);
    if (!readAt || !Number.isFinite(Date.parse(readAt))) continue;
    const classification = row.classification === "ready_to_contact" ||
        row.classification === "waiting_reply" ||
        row.classification === "follow_up_due" ||
        row.classification === "needs_decision" ||
        row.classification === "unread"
      ? row.classification
      : "unread";
    out[id] = {
      case_id: nonemptyText(row.case_id) || id,
      contact_id: nonemptyText(row.contact_id),
      read_ok: row.read_ok === true,
      reason: nonemptyText(row.reason),
      last_inbound_at: nonemptyText(row.last_inbound_at),
      last_human_outbound_at: nonemptyText(row.last_human_outbound_at),
      last_outbound_at: nonemptyText(row.last_outbound_at),
      quiet_window: row.quiet_window === true,
      quiet_hours: typeof row.quiet_hours === "number"
        ? row.quiet_hours
        : SALES_BOOKING_QUIET_HOURS,
      classification,
      message_count: typeof row.message_count === "number"
        ? row.message_count
        : 0,
      template_outbound_count: typeof row.template_outbound_count === "number"
        ? row.template_outbound_count
        : 0,
      read_at: new Date(Date.parse(readAt)).toISOString(),
    };
  }
  return out;
}

export function isSalesBookingGhl429(error: unknown): boolean {
  if (!error) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 429) return true;
  const message = String((error as Error).message || "");
  return /\bGHL 429\b/.test(message) ||
    /\b429 Too Many Requests\b/i.test(message);
}

/** attempt 1 → 200ms + jitter, then 400, 800; cap 2000ms. */
export function salesBookingGhl429DelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exp = Math.max(0, Math.trunc(attempt) - 1);
  const base = Math.min(
    SALES_BOOKING_GHL_429_BASE_MS * (2 ** exp),
    2_000,
  );
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  const jitter = Math.floor(unit * (base / 2));
  return base + jitter;
}

export async function withSalesBookingGhl429Retry<T>(
  run: () => Promise<T>,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    tries?: number;
    now?: () => Date;
    deadlineMs?: number;
  } = {},
): Promise<T> {
  const tries = Math.min(
    Math.max(1, opts.tries ?? SALES_BOOKING_GHL_429_TRIES),
    SALES_BOOKING_GHL_429_TRIES,
  );
  const sleep = opts.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => new Date());
  let lastError: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (
      opts.deadlineMs != null && Number.isFinite(opts.deadlineMs) &&
      now().getTime() >= opts.deadlineMs
    ) {
      if (lastError) throw lastError;
      throw new Error("time budget exhausted");
    }
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isSalesBookingGhl429(error) || attempt >= tries) throw error;
      const delay = salesBookingGhl429DelayMs(attempt, random);
      if (
        opts.deadlineMs != null && Number.isFinite(opts.deadlineMs) &&
        now().getTime() + delay >= opts.deadlineMs
      ) {
        throw error;
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

export function confirmSalesBookingGhlUser(args: {
  users: GhlLocationUser[];
  email: string;
  nameMatch?: string | null;
  claimedId?: string | null;
}): {
  id: string | null;
  reason: string | null;
  match: "email" | "name" | null;
  ghl_email: string | null;
} {
  const email = confirmGhlUserId({
    users: args.users,
    email: args.email,
    claimedId: args.claimedId,
  });
  if (email.id) {
    const matched = args.users.find((user) => user.id === email.id);
    return {
      id: email.id,
      reason: null,
      match: "email",
      ghl_email: matched?.email ?? args.email.trim().toLowerCase(),
    };
  }
  const needle = nonemptyText(args.nameMatch)?.toLowerCase();
  if (!needle) {
    return {
      id: null,
      reason: email.reason || "ghl_user_unmapped",
      match: null,
      ghl_email: null,
    };
  }
  const nameHits = args.users.filter((user) => {
    const first = (user.firstName || "").trim().toLowerCase();
    const display = (user.name || "").trim().toLowerCase();
    const firstToken = display.split(/\s+/)[0] || "";
    return first === needle || display === needle || firstToken === needle;
  });
  if (nameHits.length !== 1) {
    return {
      id: null,
      reason: "ghl_user_unmapped",
      match: null,
      ghl_email: null,
    };
  }
  const hit = nameHits[0];
  const claimed = nonemptyText(args.claimedId);
  if (claimed && claimed !== hit.id) {
    return {
      id: null,
      reason: "ghl_user_unmapped",
      match: null,
      ghl_email: hit.email,
    };
  }
  return {
    id: hit.id,
    reason: null,
    match: "name",
    ghl_email: hit.email,
  };
}

// ════════════════════════════════════════════════════════════
// Cases (pure)
// ════════════════════════════════════════════════════════════

export type SalesBookingStampState = "none" | "approved" | "rejected";

export interface SalesBookingCaseProposal {
  disposition: string;
  day: string | null;
  window_start: string | null;
  window_end: string | null;
  draft: string | null;
  why: string[];
}

/**
 * One engine pack lead, keyed on `pack.proposals` by opportunity id (or the
 * lead id when there is none). Independent of the roster and stage filter.
 */
export interface SalesBookingPackProposal {
  disposition: string | null;
  /** Window object as stored on the pack lead. */
  window: unknown;
  /** Stored pack `window.day`. */
  day: string | null;
  draft: string | null;
  offer: boolean;
  name: string | null;
  suburb: string | null;
  opportunity_id: string | null;
  contact_id: string | null;
  stage: string | null;
  status: string | null;
  calendar_event_id: string | null;
}

export interface SalesBookingPackView {
  present: boolean;
  as_of: string | null;
  proposals: Record<string, SalesBookingPackProposal>;
}

export function emptySalesBookingPackView(): SalesBookingPackView {
  return { present: false, as_of: null, proposals: {} };
}

export interface SalesBookingCase {
  id: string;
  resource_id: string;
  opportunity_id: string;
  contact_id: string | null;
  /**
   * Contact city / suburb, parsed WA address, or the linked job's site suburb.
   * `"not given"` when none of those exist. Never invented.
   */
  suburb: string;
  /** `patio` / `fencing` from custom fields or enquiry tags. `"not given"` when absent. */
  job_type: string;
  /** Opportunity created timestamp, or null when GHL did not send one. */
  enquiry_at: string | null;
  display_name: string;
  status: string;
  tags: string[];
  /** Additive: GHL stage name when the pipeline stage map resolved it. */
  stage_name: string | null;
  /** GHL `pipelineStageId` as stored, beside `stage_name`. */
  pipeline_stage_id: string | null;
  /** Additive: newest GHL activity timestamp, used to order the thread budget. */
  last_activity_at: string | null;
  /** Latest engine pack row for this opportunity, or null when no pack matched. */
  proposal: SalesBookingCaseProposal | null;
  stamp_state: SalesBookingStampState;
}

/** A contact whose "name" is really a phone number is an unnamed enquiry. */
export function isPhoneLikeName(name: unknown): boolean {
  const text = String(name ?? "").replace(/\s/g, "");
  return /^(\+61|0)\d/.test(text);
}

function nonemptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const SUBURB_FIELD_KEYS = new Set([
  "suburb",
  "city",
  "site_suburb",
  "site suburb",
  "location",
  "area",
]);

/** WA / W.A / W.A. / Western Australia, optional postcode. */
const WA_PLACE_TAIL_RE =
  /(?:,\s*|\s+)(?:WA|W\.A\.?|Western Australia)(?:\s+\d{4})?(?:,\s*Australia)?\s*$/i;

/**
 * Contact city / suburb, nested address city, or a WA suburb parsed from a
 * street line or a GHL custom-field address. Never guesses: no city and no
 * parseable suburb is `"not given"`.
 */
export function salesBookingSuburbFromContact(
  contact: Record<string, unknown>,
  opportunity: Record<string, unknown> = {},
): string {
  const nestedAddress =
    (contact.address && typeof contact.address === "object"
      ? contact.address
      : opportunity.address && typeof opportunity.address === "object"
      ? opportunity.address
      : null) as Record<string, unknown> | null;
  const city = nonemptyText(contact.city) ||
    nonemptyText(contact.suburb) ||
    nonemptyText(contact.contactCity) ||
    nonemptyText(nestedAddress?.city) ||
    nonemptyText(opportunity.city) ||
    nonemptyText(opportunity.suburb) ||
    nonemptyText(opportunity.contactCity);
  if (city) {
    const parsedCity = salesBookingSuburbFromAddressLine(city) ||
      salesBookingSuburbFromStreetLine(city);
    if (parsedCity) return parsedCity;
    const strippedCity = stripAddressPlaceTail(city);
    if (strippedCity && !salesBookingLooksLikeStreet(strippedCity)) {
      return strippedCity;
    }
  }
  const fields = collectCustomFieldValues(contact, opportunity);
  for (const field of fields) {
    if (!SUBURB_FIELD_KEYS.has(field.key)) continue;
    const parsed = salesBookingSuburbFromAddressLine(field.value) ||
      salesBookingSuburbFromStreetLine(field.value);
    if (parsed) return parsed;
    if (!salesBookingLooksLikeStreet(field.value)) return field.value;
  }
  for (const field of fields) {
    const parsed = salesBookingSuburbFromAddressLine(field.value) ||
      salesBookingSuburbFromStreetLine(field.value);
    if (parsed) return parsed;
  }
  const lines = [
    contact.address1,
    contact.contactAddress,
    contact.postalAddress,
    typeof contact.address === "string" ? contact.address : null,
    nestedAddress?.address1,
    nestedAddress?.line1,
    opportunity.address1,
    opportunity.contactAddress,
    typeof opportunity.address === "string" ? opportunity.address : null,
    opportunity.name,
    contact.name,
  ];
  for (const line of lines) {
    const parsed = salesBookingSuburbFromAddressLine(line) ||
      salesBookingSuburbFromStreetLine(line);
    if (parsed) return parsed;
  }
  return SALES_BOOKING_NOT_GIVEN;
}

const STREET_TYPE_RE =
  /\b(?:st|street|rd|road|ave|avenue|dr|drive|ct|court|pl|place|way|cres|crescent|crest|pde|parade|cl|close|tce|terrace|hwy|highway|blvd|circuit|cct|loop|rise|grove|lane|ln)\b/i;

/** Optional AU postcode after the suburb, with or without WA. */
const AU_POSTCODE_TAIL_RE = /(?:,\s*|\s+)\d{4}\s*$/;

function stripAddressPlaceTail(text: string): string {
  return text.replace(WA_PLACE_TAIL_RE, "").replace(AU_POSTCODE_TAIL_RE, "")
    .trim();
}

/**
 * A street line starts with a house or unit number. Suburb names may contain
 * Grove / St / Place and must still count as given.
 */
function salesBookingLooksLikeStreet(value: string): boolean {
  return /^(?:\d+[A-Za-z]?\/)?\d/.test(value.trim());
}

/**
 * "52 warrington road byford" / "2 Wedge Way, Merriwa" → suburb after the
 * street token. Street-only lines stay null.
 */
export function salesBookingSuburbFromStreetLine(
  value: unknown,
): string | null {
  const text = nonemptyText(value);
  if (!text) return null;
  const trimmed = stripAddressPlaceTail(text);
  if (!trimmed || !salesBookingLooksLikeStreet(trimmed)) return null;
  const comma = trimmed.match(/,\s*([A-Za-z][A-Za-z .'-]{1,40})\s*$/);
  const afterComma = nonemptyText(comma?.[1]);
  if (
    afterComma && !salesBookingLooksLikeStreet(afterComma) &&
    !/^\d/.test(afterComma)
  ) {
    return afterComma;
  }
  const afterStreet = trimmed.match(
    new RegExp(
      `${STREET_TYPE_RE.source}\\s+([A-Za-z][A-Za-z .'-]{1,40}?)\\s*$`,
      "i",
    ),
  );
  const suburb = nonemptyText(afterStreet?.[1]);
  return suburb && !/^\d/.test(suburb) && !STREET_TYPE_RE.test(suburb)
    ? suburb
    : null;
}

/** WA street line → suburb. Misses stay null rather than taking the street. */
export function salesBookingSuburbFromAddressLine(
  value: unknown,
): string | null {
  const text = nonemptyText(value);
  if (!text) return null;
  const afterComma = text.match(
    /,\s*([A-Za-z][A-Za-z .'-]{1,40}?)\s*(?:,\s*|\s+)(?:WA|W\.A\.?|Western Australia)(?:\s+\d{4})?(?:,\s*Australia)?\s*$/i,
  );
  const commaSuburb = nonemptyText(afterComma?.[1]);
  if (
    commaSuburb && !/^\d/.test(commaSuburb) && !STREET_TYPE_RE.test(commaSuburb)
  ) {
    return commaSuburb;
  }
  const whole = text.match(
    /^([A-Za-z][A-Za-z .'-]{1,40}?)\s+(?:WA|W\.A\.?|Western Australia)(?:\s+\d{4})?\s*$/i,
  );
  const wholeSuburb = nonemptyText(whole?.[1]);
  if (
    wholeSuburb && !STREET_TYPE_RE.test(wholeSuburb)
  ) {
    return wholeSuburb;
  }
  const tail = text.match(
    /\s([A-Za-z][A-Za-z'-]{1,40})\s+(?:WA|W\.A\.?|Western Australia)(?:\s+\d{4})?(?:,\s*Australia)?\s*$/i,
  );
  const suburb = nonemptyText(tail?.[1]);
  return suburb && !STREET_TYPE_RE.test(suburb) ? suburb : null;
}

function customFieldValue(rec: Record<string, unknown>): unknown {
  return rec.fieldValue ?? rec.field_value ?? rec.value ?? rec.name;
}

function collectCustomFieldValues(
  ...sources: Record<string, unknown>[]
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const push = (key: unknown, value: unknown) => {
    const k = nonemptyText(key)?.toLowerCase() || "";
    const v = nonemptyText(value);
    if (k && v) out.push({ key: k, value: v });
  };
  for (const source of sources) {
    const fields = source.customFields ?? source.customData;
    if (Array.isArray(fields)) {
      for (const row of fields) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        push(
          rec.key ?? rec.fieldKey ?? rec.id ?? rec.name,
          customFieldValue(rec),
        );
      }
    } else if (fields && typeof fields === "object") {
      for (
        const [key, value] of Object.entries(fields as Record<string, unknown>)
      ) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const rec = value as Record<string, unknown>;
          push(key, customFieldValue(rec));
        } else {
          push(key, value);
        }
      }
    }
  }
  return out;
}

function mapSalesBookingJobWords(
  text: string,
): "patio" | "fencing" | null {
  const patio = /\bpatios?\b/i.test(text);
  const fencing = /\bfenc(?:e|ing|es)\b/i.test(text);
  if (patio && fencing) return null;
  if (patio) return "patio";
  if (fencing) return "fencing";
  return null;
}

const JOB_TYPE_FIELD_KEYS = new Set([
  "job_type",
  "jobtype",
  "job type",
  "type",
  "enquiry_type",
  "enquiry type",
  "product",
  "service",
  "division",
]);

/**
 * Custom-field job type first, then enquiry tags mapped to patio / fencing.
 * The resource pipeline family is last: Nithin is the patio book, Marnin
 * the fencing book. `"not given"` only when none of those name a family.
 */
export function salesBookingJobTypeFromOpportunity(
  opportunity: Record<string, unknown>,
  contact: Record<string, unknown> = {},
  lane?: "patio" | "fencing" | string | null,
): string {
  const fields = collectCustomFieldValues(opportunity, contact);
  for (const field of fields) {
    if (!JOB_TYPE_FIELD_KEYS.has(field.key)) continue;
    const mapped = mapSalesBookingJobWords(field.value);
    if (mapped) return mapped;
  }
  for (const field of fields) {
    const mapped = mapSalesBookingJobWords(`${field.key} ${field.value}`);
    if (mapped) return mapped;
  }
  const tags = [
    ...(Array.isArray(contact.tags) ? contact.tags : []),
    ...(Array.isArray(opportunity.tags) ? opportunity.tags : []),
  ].map((tag) => String(tag));
  const mappedTags = new Set<"patio" | "fencing">();
  for (const tag of tags) {
    const mapped = mapSalesBookingJobWords(tag);
    if (mapped) mappedTags.add(mapped);
  }
  if (mappedTags.size === 1) return [...mappedTags][0];
  return lane === "patio" || lane === "fencing"
    ? lane
    : SALES_BOOKING_NOT_GIVEN;
}

function salesBookingEnquiryAt(
  opportunity: Record<string, unknown>,
): string | null {
  const raw = [opportunity.createdAt, opportunity.dateAdded].find((value) =>
    typeof value === "string" && value
  );
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

function salesBookingTags(
  contact: Record<string, unknown>,
  opportunity: Record<string, unknown>,
): string[] {
  const raw = Array.isArray(contact.tags)
    ? contact.tags
    : Array.isArray(opportunity.tags)
    ? opportunity.tags
    : [];
  return raw.map((tag) => String(tag));
}

export interface SalesBookingContactFact {
  city?: unknown;
  suburb?: unknown;
  address1?: unknown;
  address?: unknown;
  postalAddress?: unknown;
  tags?: unknown;
  customFields?: unknown;
  customData?: unknown;
}

/** Linked job site when GHL city/address is empty. Never invented. */
export interface SalesBookingJobSiteFact {
  suburb?: unknown;
  address?: unknown;
}

/** Overlay a GHL contact read onto a search row that omitted city/tags. */
export function applySalesBookingContactFact(
  opportunity: Record<string, unknown>,
  fact: SalesBookingContactFact | null | undefined,
): Record<string, unknown> {
  if (!fact) return opportunity;
  const contact = {
    ...((opportunity.contact && typeof opportunity.contact === "object"
      ? opportunity.contact
      : {}) as Record<string, unknown>),
  };
  const fill = (key: string, value: unknown) => {
    if (value == null || value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    const current = contact[key];
    if (current == null || current === "") {
      contact[key] = value;
      return;
    }
    if (Array.isArray(current) && current.length === 0) contact[key] = value;
  };
  fill("city", fact.city);
  fill("city", fact.suburb);
  fill("address1", fact.address1);
  fill("address", fact.address);
  fill("postalAddress", fact.postalAddress);
  fill("tags", fact.tags);
  fill("customFields", fact.customFields);
  fill("customData", fact.customData);
  return { ...opportunity, contact };
}

export function salesBookingContactId(
  opportunity: Record<string, unknown>,
): string | null {
  const contact =
    (opportunity.contact && typeof opportunity.contact === "object"
      ? opportunity.contact
      : {}) as Record<string, unknown>;
  return nonemptyText(contact.id) || nonemptyText(opportunity.contactId);
}

export function salesBookingContactFactFromGhl(
  body: Record<string, unknown>,
): SalesBookingContactFact {
  const contact =
    (body.contact && typeof body.contact === "object"
      ? body.contact
      : body) as Record<string, unknown>;
  return {
    city: contact.city,
    suburb: contact.suburb,
    address1: contact.address1,
    address: contact.address,
    postalAddress: contact.postalAddress,
    tags: contact.tags,
    customFields: contact.customFields,
    customData: contact.customData,
  };
}

/**
 * Project one raw GHL opportunity onto a case row. Never invents a suburb:
 * absent city/address/job site stays `"not given"`. Job type prefers custom
 * fields and enquiry tags, then the resource pipeline family.
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
  const stageId = nonemptyText(opportunity.pipelineStageId);
  const updatedAt = [
    opportunity.updatedAt,
    opportunity.dateUpdated,
    opportunity.lastStatusChangeAt,
    opportunity.createdAt,
  ].find((value) => typeof value === "string" && value);
  const lane = SALES_BOOKING_RESOURCES[resourceId]?.lane;
  return {
    id,
    resource_id: resourceId,
    opportunity_id: id,
    contact_id: salesBookingContactId(opportunity),
    suburb: salesBookingSuburbFromContact(contact, opportunity),
    job_type: salesBookingJobTypeFromOpportunity(opportunity, contact, lane),
    enquiry_at: salesBookingEnquiryAt(opportunity),
    display_name: isPhoneLikeName(rawName) ? "Enquiry" : (rawName || "Enquiry"),
    status: "needs_decision",
    tags: salesBookingTags(contact, opportunity),
    stage_name: (stageId && stages[stageId]) || null,
    pipeline_stage_id: stageId,
    last_activity_at: typeof updatedAt === "string" ? updatedAt : null,
    proposal: null,
    stamp_state: "none",
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
  /** How this scan was obtained. Default live for callers that omit it. */
  source?: "cache" | "live";
  /** Age of the cached roster in ms; 0 when live; null when unknown. */
  age_ms?: number | null;
  remaining_429_count?: number;
  /** Next GHL search page. Set on an incomplete scan so the next read can resume. */
  start_after?: string | number | null;
  start_after_id?: string | null;
}

export interface SalesBookingCachedRoster {
  opportunities: Record<string, unknown>[];
  stages: Record<string, string>;
  exhausted: boolean;
  pages_scanned: number;
  total: number | null;
  reason: string | null;
  read_at: string;
  start_after?: string | number | null;
  start_after_id?: string | null;
}

/** Cached roster is usable when younger than 10 minutes. */
export function salesBookingRosterIsFresh(args: {
  cachedReadAt: string | null | undefined;
  nowMs: number;
  maxAgeMs?: number;
}): boolean {
  const readAtMs = Date.parse(String(args.cachedReadAt || ""));
  if (!Number.isFinite(readAtMs)) return false;
  const maxAge = args.maxAgeMs ?? SALES_BOOKING_ROSTER_CACHE_MAX_AGE_MS;
  return args.nowMs - readAtMs < maxAge;
}

export function parseSalesBookingRosterCache(
  payload: unknown,
): SalesBookingCachedRoster | null {
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const readAt = nonemptyText(body.read_at);
  if (!readAt || !Number.isFinite(Date.parse(readAt))) return null;
  const opportunities = Array.isArray(body.opportunities)
    ? body.opportunities.filter((row) =>
      !!row && typeof row === "object" && !Array.isArray(row)
    ) as Record<string, unknown>[]
    : [];
  const stagesRaw = body.stages && typeof body.stages === "object" &&
      !Array.isArray(body.stages)
    ? body.stages as Record<string, unknown>
    : {};
  const stages: Record<string, string> = {};
  for (const [id, name] of Object.entries(stagesRaw)) {
    if (id) stages[id] = String(name ?? "");
  }
  return {
    opportunities,
    stages,
    exhausted: body.exhausted === true,
    pages_scanned: typeof body.pages_scanned === "number"
      ? body.pages_scanned
      : 0,
    total: typeof body.total === "number" ? body.total : null,
    reason: nonemptyText(body.reason),
    read_at: new Date(Date.parse(readAt)).toISOString(),
    start_after: rosterCursorValue(body.start_after),
    start_after_id: nonemptyText(body.start_after_id),
  };
}

function rosterCursorValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return nonemptyText(value);
}

export function salesBookingRosterIsComplete(
  roster:
    | Pick<
      SalesBookingCachedRoster,
      "exhausted" | "reason"
    >
    | Pick<SalesBookingOpportunityScan, "exhausted" | "reason">
    | null
    | undefined,
): boolean {
  return !!roster && roster.exhausted === true && !roster.reason;
}

function rosterResumeCursor(
  cached: SalesBookingCachedRoster | null,
): { startAfter: string | number; startAfterId: string } | null {
  if (!cached || salesBookingRosterIsComplete(cached)) return null;
  const startAfter = rosterCursorValue(cached.start_after);
  const startAfterId = nonemptyText(cached.start_after_id);
  if (startAfter == null || !startAfterId) return null;
  return { startAfter, startAfterId };
}

function mergeResumedRosterScan(
  cached: SalesBookingCachedRoster,
  live: SalesBookingOpportunityScan,
): SalesBookingOpportunityScan {
  const seen = new Set<string>();
  const opportunities: Record<string, unknown>[] = [];
  for (const row of [...cached.opportunities, ...live.opportunities]) {
    const id = typeof row.id === "string" ? row.id : "";
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    opportunities.push(row);
  }
  const exhausted = live.exhausted === true;
  return {
    opportunities,
    stages: { ...cached.stages, ...live.stages },
    exhausted,
    pages_scanned: (cached.pages_scanned || 0) + (live.pages_scanned || 0),
    total: live.total ?? cached.total,
    reason: live.reason,
    source: "live",
    age_ms: 0,
    remaining_429_count: live.remaining_429_count ?? 0,
    start_after: exhausted
      ? null
      : live.start_after ?? cached.start_after ?? null,
    start_after_id: exhausted
      ? null
      : live.start_after_id ?? cached.start_after_id ?? null,
  };
}

export function scanFromCachedRoster(
  cached: SalesBookingCachedRoster,
  nowMs: number,
  extra: {
    reason?: string | null;
    remaining_429_count?: number;
  } = {},
): SalesBookingOpportunityScan {
  const readAtMs = Date.parse(cached.read_at);
  return {
    opportunities: cached.opportunities,
    stages: cached.stages,
    exhausted: cached.exhausted,
    pages_scanned: cached.pages_scanned,
    total: cached.total,
    reason: extra.reason !== undefined ? extra.reason : cached.reason,
    source: "cache",
    age_ms: Number.isFinite(readAtMs) ? Math.max(0, nowMs - readAtMs) : null,
    remaining_429_count: extra.remaining_429_count ?? 0,
    start_after: cached.start_after ?? null,
    start_after_id: cached.start_after_id ?? null,
  };
}

export function cachedRosterFromScan(
  scan: SalesBookingOpportunityScan,
  readAt: string,
): SalesBookingCachedRoster {
  return {
    opportunities: scan.opportunities,
    stages: scan.stages,
    exhausted: scan.exhausted,
    pages_scanned: scan.pages_scanned,
    total: scan.total,
    reason: scan.reason,
    read_at: readAt,
    start_after: scan.exhausted ? null : scan.start_after ?? null,
    start_after_id: scan.exhausted ? null : scan.start_after_id ?? null,
  };
}

function rosterScanLooksLike429(scan: SalesBookingOpportunityScan): boolean {
  if ((scan.remaining_429_count ?? 0) > 0) return true;
  return isSalesBookingGhl429({ message: scan.reason || "" });
}

/**
 * Serve a fresh complete cached roster; otherwise live-refresh. A complete
 * cache always beats an incomplete live result. An incomplete cache is
 * resumed from its page cursor and persisted until the book is complete.
 */
export async function resolveSalesBookingRoster(args: {
  cached: SalesBookingCachedRoster | null;
  nowMs: number;
  forceRefresh?: boolean;
  live: (resume?: {
    startAfter?: string | number | null;
    startAfterId?: string | null;
  }) => Promise<SalesBookingOpportunityScan>;
}): Promise<{
  scan: SalesBookingOpportunityScan;
  shouldPersist: boolean;
}> {
  const cached = args.cached;
  const cachedComplete = salesBookingRosterIsComplete(cached);
  const fresh = cachedComplete && !!cached && !args.forceRefresh &&
    salesBookingRosterIsFresh({
      cachedReadAt: cached.read_at,
      nowMs: args.nowMs,
    });
  if (fresh && cached) {
    return {
      scan: scanFromCachedRoster(cached, args.nowMs),
      shouldPersist: false,
    };
  }
  const resume = rosterResumeCursor(cached);
  const live = await args.live(resume ?? undefined);
  const liveScan: SalesBookingOpportunityScan = {
    ...live,
    source: "live",
    age_ms: 0,
    remaining_429_count: live.remaining_429_count ?? 0,
  };
  const merged = resume && cached
    ? mergeResumedRosterScan(cached, liveScan)
    : liveScan;
  if (cachedComplete && cached && !salesBookingRosterIsComplete(merged)) {
    const like429 = rosterScanLooksLike429(merged);
    return {
      scan: scanFromCachedRoster(cached, args.nowMs, {
        reason: merged.reason ||
          (like429 ? "GHL 429" : "incomplete live refresh"),
        remaining_429_count: like429
          ? Math.max(1, merged.remaining_429_count ?? 1)
          : merged.remaining_429_count ?? 0,
      }),
      shouldPersist: false,
    };
  }
  return {
    scan: merged,
    shouldPersist: true,
  };
}

export interface SalesBookingDiaryScan {
  read_ok: boolean;
  reason: string | null;
  entries: SalesBookingDiaryEntry[];
  malformed_dropped: number;
  calendar_email: string | null;
  ghl_user_id: string | null;
  /** Which roster field confirmed `ghl_user_id`. Name is weaker than email. */
  mapped_by: "email" | "name" | null;
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
  cached_count: number;
  fresh_count: number;
  unread_count: number;
  remaining_429_count: number;
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
    threads_cached: number;
    threads_fresh: number;
    threads_unread: number;
    remaining_429_count: number;
    diary_read_ok: boolean;
    roster_source: "cache" | "live";
    roster_age_ms: number | null;
  };
  cases: SalesBookingCase[];
  diary: SalesBookingDiaryEntry[];
  diary_read: {
    read_ok: boolean;
    reason: string | null;
    source: string;
    calendar_email: string | null;
    ghl_user_id: string | null;
    mapped_by: "email" | "name" | null;
  };
  thread_facts: Record<string, SalesBookingThreadFacts>;
  drafts: Record<string, string>;
  pack: SalesBookingPackView;
  stamp: {
    present: boolean;
    as_of: string | null;
    approved: string[];
    rejected: string[];
    decisions: Record<string, "hold" | "replace">;
    stage_moves: Array<{ id: string; to_stage_id: string }>;
  };
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
  if (opportunities.source === "cache") {
    const age = opportunities.age_ms;
    const ageLabel = age == null
      ? "unknown age"
      : `${Math.round(age / 1000)}s old`;
    gaps.push(
      rosterScanLooksLike429(opportunities)
        ? `Opportunity roster served from cache after GHL 429 (${ageLabel}).`
        : `Opportunity roster served from cache (${ageLabel}).`,
    );
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
    const unread = threads.unread_count;
    if (threads.cached_count > 0) {
      gaps.push(
        `${threads.cached_count} thread(s) served from cache without a live GHL read.`,
      );
    }
    if (threads.fresh_count > 0) {
      gaps.push(
        `${threads.fresh_count} thread(s) refreshed live from GHL this read.`,
      );
    }
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
        `${unread} thread(s) unread; those cases stay on the board as unread.`,
      );
    }
  }

  const remaining429 = (threads.remaining_429_count || 0) +
    (opportunities.remaining_429_count || 0);
  if (remaining429 > 0) {
    gaps.push(
      `${remaining429} GHL 429 Too Many Requests remaining after retries.`,
    );
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
      full_population: opportunities.exhausted === true &&
        (opportunities.source === "cache" || !opportunities.reason),
      enumerated: cases.length,
      total: opportunities.total,
      excluded_by_stage: input.excludedByStage ?? 0,
      operational_leave: "not_read",
      gaps,
      pages_scanned: opportunities.pages_scanned,
      threads_read: threads.read_ok_count,
      threads_attempted: threads.attempted,
      threads_cached: threads.cached_count,
      threads_fresh: threads.fresh_count,
      threads_unread: threads.unread_count,
      remaining_429_count: (threads.remaining_429_count || 0) +
        (opportunities.remaining_429_count || 0),
      diary_read_ok: diary.read_ok,
      roster_source: opportunities.source === "cache" ? "cache" : "live",
      roster_age_ms: opportunities.age_ms ??
        (opportunities.source === "cache" ? null : 0),
    },
    cases,
    diary: diary.entries,
    diary_read: {
      read_ok: diary.read_ok,
      reason: diary.reason,
      source: DIARY_SOURCE,
      calendar_email: diary.calendar_email,
      ghl_user_id: diary.ghl_user_id,
      mapped_by: diary.mapped_by,
    },
    thread_facts: threads.facts,
    // Pack overlay (proposals, drafts, stamp) is applied after this assemble
    // by sales_booking_pack.ts. Absent here means the engine has not published.
    drafts: {},
    pack: emptySalesBookingPackView(),
    stamp: {
      present: false,
      as_of: null,
      approved: [],
      rejected: [],
      decisions: {},
      stage_moves: [],
    },
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
  /** Whole-read wall clock. Capped at 25s. */
  read_budget_ms?: number;
  case_ids?: string[] | null;
  /** Bypass thread-facts freshness and the 10-minute window on a complete roster. An incomplete roster always resumes from its cursor. */
  force_refresh?: boolean;
}

export interface SalesBookingReadDependencies {
  /** Bounded, terminal-or-honest GHL opportunity roster for one pipeline. */
  readOpportunities(
    args: {
      pipelineId: string;
      deadlineMs?: number;
      startAfter?: string | number | null;
      startAfterId?: string | null;
    },
  ): Promise<SalesBookingOpportunityScan>;
  /** One scoper's GHL calendar events for the week. Never throws. */
  readDiary(args: {
    resourceId: string;
    scoperUserId: string;
    since: string;
    untilExclusive: string;
    deadlineMs?: number;
  }): Promise<SalesBookingDiaryScan>;
  /** One contact's GHL conversation messages. Rejects on a failed read. */
  readThread(args: {
    contactId: string;
    deadlineMs?: number;
  }): Promise<SalesBookingMessage[]>;
  /**
   * City/tags/custom fields for scoped contact ids. Search rows omit these.
   * Optional: tests that only exercise roster shape can skip it.
   */
  readContacts?(
    contactIds: string[],
    opts?: { deadlineMs?: number },
  ): Promise<Record<string, SalesBookingContactFact>>;
  /**
   * Recorded job site for scoped opportunity / contact ids. Used only when
   * the GHL contact has no parseable suburb. Optional.
   */
  readJobSites?(
    ids: { opportunityIds: string[]; contactIds: string[] },
  ): Promise<Record<string, SalesBookingJobSiteFact>>;
  now(): Date;
  loadThreadFactsCache?(
    resourceId: string,
  ): Promise<Record<string, SalesBookingCachedThreadFact>>;
  persistThreadFactsCache?(
    resourceId: string,
    facts: Record<string, SalesBookingCachedThreadFact>,
  ): Promise<void>;
  loadRosterCache?(
    resourceId: string,
  ): Promise<SalesBookingCachedRoster | null>;
  persistRosterCache?(
    resourceId: string,
    roster: SalesBookingCachedRoster,
  ): Promise<void>;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

function emptyThreadScan(
  enabled: boolean,
  notAttempted: number,
): SalesBookingThreadScan {
  return {
    facts: {},
    attempted: 0,
    read_ok_count: 0,
    not_attempted: notAttempted,
    budget_exhausted: false,
    enabled,
    cached_count: 0,
    fresh_count: 0,
    unread_count: enabled ? notAttempted : 0,
    remaining_429_count: 0,
  };
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

function asCachedThreadFact(
  facts: SalesBookingThreadFacts,
  readAt: string,
): SalesBookingCachedThreadFact {
  return { ...facts, read_at: readAt };
}

/**
 * Serve cached thread facts; live-refresh only stale or missing rows, newest
 * first, under the time budget. Page load persists the merged map.
 */
async function scanThreads(
  deps: SalesBookingReadDependencies,
  resourceId: string,
  cases: SalesBookingCase[],
  params: SalesBookingReadParams,
  deadlineMs?: number,
): Promise<SalesBookingThreadScan> {
  const enabled = params.include_thread_facts !== false;
  const facts: Record<string, SalesBookingThreadFacts> = {};
  if (!enabled || cases.length === 0) {
    return emptyThreadScan(enabled, enabled ? cases.length : 0);
  }

  const requestedBudget = clampInt(
    params.thread_budget_ms,
    SALES_BOOKING_DEFAULT_THREAD_BUDGET_MS,
    0,
    60_000,
  );
  const remaining = deadlineMs != null
    ? Math.max(0, deadlineMs - deps.now().getTime())
    : requestedBudget;
  const budgetMs = Math.min(requestedBudget, remaining);
  const limit = clampInt(
    params.thread_limit,
    SALES_BOOKING_DEFAULT_THREAD_LIMIT,
    0,
    SALES_BOOKING_MAX_THREAD_LIMIT,
  );
  const forceRefresh = params.force_refresh === true;
  const wanted = params.case_ids && params.case_ids.length
    ? new Set(params.case_ids.map((id) => String(id)))
    : null;
  const nowMs = deps.now().getTime();

  const ordered = cases
    .filter((row) => (wanted ? wanted.has(row.id) : true))
    .slice()
    .sort((a, b) =>
      Date.parse(b.last_activity_at || "") -
        Date.parse(a.last_activity_at || "") || a.id.localeCompare(b.id)
    );

  let cachedStore: Record<string, SalesBookingCachedThreadFact> = {};
  let cacheLoadFailed = false;
  try {
    cachedStore = deps.loadThreadFactsCache
      ? await deps.loadThreadFactsCache(resourceId)
      : {};
  } catch {
    cacheLoadFailed = true;
    cachedStore = {};
  }

  const cachedHits: string[] = [];
  const stale: SalesBookingCase[] = [];
  for (const row of ordered) {
    const cached = cachedStore[row.id] || cachedStore[row.opportunity_id];
    const fresh = !forceRefresh && !!cached &&
      salesBookingThreadFactIsFresh({
        cachedReadAt: cached.read_at,
        lastActivityAt: row.last_activity_at,
        nowMs,
      });
    if (fresh && cached) {
      facts[row.id] = { ...cached, case_id: row.id };
      cachedHits.push(row.id);
    } else {
      stale.push(row);
    }
  }

  const selected = stale.slice(0, limit);
  const startedAt = deps.now().getTime();
  let budgetExhausted = false;
  let remaining429 = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= selected.length) return;
      if (
        deps.now().getTime() - startedAt >= budgetMs ||
        (deadlineMs != null && deps.now().getTime() >= deadlineMs)
      ) {
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
        const messages = await deps.readThread({
          contactId: row.contact_id,
          deadlineMs,
        });
        facts[row.id] = deriveSalesBookingThreadFacts({
          caseId: row.id,
          contactId: row.contact_id,
          messages,
          nowMs: deps.now().getTime(),
        });
      } catch (error) {
        const staleCache = cachedStore[row.id] ||
          cachedStore[row.opportunity_id];
        if (isSalesBookingGhl429(error)) remaining429++;
        if (staleCache) {
          facts[row.id] = { ...staleCache, case_id: row.id };
          cachedHits.push(row.id);
          continue;
        }
        facts[row.id] = unreadSalesBookingThreadFacts(
          row.id,
          row.contact_id,
          `ghl_thread_unread: ${(error as Error)?.message || "unknown"}`,
        );
      }
    }
  };

  if (selected.length > 0) {
    await Promise.all(
      Array.from({
        length: Math.min(SALES_BOOKING_THREAD_CONCURRENCY, selected.length),
      }, () => worker()),
    );
  }

  const attempted = Object.keys(facts).length;
  const readOk = Object.values(facts).filter((f) => f.read_ok).length;
  const notAttempted = Math.max(
    0,
    (wanted ? ordered.length : cases.length) - attempted,
  );
  const unreadCount = Object.values(facts).filter((f) => !f.read_ok).length +
    notAttempted;
  const cachedCount =
    Object.keys(facts).filter((id) => cachedHits.includes(id)).length;
  const freshCount = selected.filter((row) => {
    const fact = facts[row.id];
    return fact?.read_ok === true && !cachedHits.includes(row.id);
  }).length;

  const merged: Record<string, SalesBookingCachedThreadFact> = {
    ...cachedStore,
  };
  for (const [id, fact] of Object.entries(facts)) {
    if (fact.read_at) merged[id] = asCachedThreadFact(fact, fact.read_at);
  }
  if (
    deps.persistThreadFactsCache && selected.length > 0 && !cacheLoadFailed
  ) {
    try {
      await deps.persistThreadFactsCache(resourceId, merged);
    } catch {
      // Cache write must not empty the board.
    }
  }

  return {
    facts,
    attempted,
    read_ok_count: readOk,
    not_attempted: notAttempted,
    budget_exhausted: budgetExhausted,
    enabled,
    cached_count: cachedCount,
    fresh_count: freshCount,
    unread_count: unreadCount,
    remaining_429_count: remaining429,
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

  const startedAt = deps.now().getTime();
  const budgetMs = clampInt(
    params.read_budget_ms,
    SALES_BOOKING_READ_BUDGET_MS,
    1,
    SALES_BOOKING_READ_BUDGET_MS,
  );
  const deadlineMs = startedAt + budgetMs;
  const forceRefresh = params.force_refresh === true;

  let cachedRoster: SalesBookingCachedRoster | null = null;
  try {
    cachedRoster = deps.loadRosterCache
      ? await deps.loadRosterCache(resource.resource_id)
      : null;
  } catch {
    cachedRoster = null;
  }

  const liveRoster = (
    resume?: {
      startAfter?: string | number | null;
      startAfterId?: string | null;
    },
  ) =>
    deps.readOpportunities({
      pipelineId: resource.pipeline_id,
      deadlineMs,
      startAfter: resume?.startAfter,
      startAfterId: resume?.startAfterId,
    });
  const rosterFresh = !!cachedRoster &&
    salesBookingRosterIsComplete(cachedRoster) &&
    !forceRefresh &&
    salesBookingRosterIsFresh({
      cachedReadAt: cachedRoster.read_at,
      nowMs: deps.now().getTime(),
    });

  const [resolved, diary] = await Promise.all([
    rosterFresh && cachedRoster
      ? Promise.resolve({
        scan: scanFromCachedRoster(cachedRoster, deps.now().getTime()),
        shouldPersist: false,
      })
      : resolveSalesBookingRoster({
        cached: cachedRoster,
        nowMs: deps.now().getTime(),
        forceRefresh,
        live: liveRoster,
      }),
    deps.readDiary({
      resourceId: resource.resource_id,
      scoperUserId,
      since: week.since,
      untilExclusive: week.until_exclusive,
      deadlineMs,
    }),
  ]);

  let opportunities = resolved.scan;
  const scopedContactIds: string[] = [];
  const scopedOpportunityIds: string[] = [];
  for (const raw of opportunities.opportunities) {
    const stageId = typeof raw.pipelineStageId === "string"
      ? raw.pipelineStageId
      : "";
    if (!isSalesBookingScopeStage(stageId, resource.scope_stage_ids)) continue;
    const contactId = salesBookingContactId(raw);
    if (contactId) scopedContactIds.push(contactId);
    if (typeof raw.id === "string" && raw.id) scopedOpportunityIds.push(raw.id);
  }
  let contactFacts: Record<string, SalesBookingContactFact> = {};
  const hydrateLive = opportunities.source !== "cache" &&
    deps.readContacts &&
    scopedContactIds.length > 0 &&
    deps.now().getTime() < deadlineMs;
  if (hydrateLive) {
    try {
      contactFacts = await deps.readContacts!(scopedContactIds, { deadlineMs });
    } catch {
      contactFacts = {};
    }
    opportunities = {
      ...opportunities,
      opportunities: opportunities.opportunities.map((raw) => {
        const contactId = salesBookingContactId(raw);
        return applySalesBookingContactFact(
          raw,
          contactId ? contactFacts[contactId] : null,
        );
      }),
    };
  }
  if (
    resolved.shouldPersist && deps.persistRosterCache
  ) {
    try {
      await deps.persistRosterCache(
        resource.resource_id,
        cachedRosterFromScan(
          opportunities,
          deps.now().toISOString(),
        ),
      );
    } catch {
      // Cache write must not empty the board.
    }
  }
  let jobSites: Record<string, SalesBookingJobSiteFact> = {};
  if (
    deps.readJobSites &&
    (scopedOpportunityIds.length > 0 || scopedContactIds.length > 0) &&
    deps.now().getTime() < deadlineMs
  ) {
    try {
      jobSites = await deps.readJobSites({
        opportunityIds: scopedOpportunityIds,
        contactIds: scopedContactIds,
      });
    } catch {
      jobSites = {};
    }
  }

  const projected: SalesBookingCase[] = [];
  const seen = new Set<string>();
  let excludedByStage = 0;
  for (const raw of opportunities.opportunities) {
    const contactId = salesBookingContactId(raw);
    const row = projectSalesBookingCase(
      hydrateLive ? raw : applySalesBookingContactFact(
        raw,
        contactId ? contactFacts[contactId] : null,
      ),
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
    if (row.suburb === SALES_BOOKING_NOT_GIVEN) {
      const job = jobSites[row.id] ||
        (contactId ? jobSites[contactId] : undefined);
      if (job) {
        const fromJob = salesBookingSuburbFromContact({
          city: job.suburb,
          address1: job.address,
        });
        if (fromJob !== SALES_BOOKING_NOT_GIVEN) row.suburb = fromJob;
      }
    }
    projected.push(row);
  }

  const threads = await scanThreads(
    deps,
    resource.resource_id,
    projected,
    params,
    deadlineMs,
  );
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

type GhlRetryHooks = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  deadlineMs?: number;
};

async function ghlRead(
  path: string,
  init: RequestInit = {},
  retry: GhlRetryHooks = {},
): Promise<Record<string, unknown>> {
  const token = Deno.env.get("GHL_API_TOKEN") || "";
  if (!token) throw new Error("GHL API token not configured");
  return await withSalesBookingGhl429Retry(async () => {
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
    if (res.status === 429) {
      const error = new Error(`GHL 429: ${text.slice(0, 300)}`);
      (error as { status?: number }).status = 429;
      throw error;
    }
    if (!res.ok) throw new Error(`GHL ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }, retry);
}

/**
 * City, address, tags, and custom fields for scoped contacts. Opportunity
 * search omits them; GET /contacts/{id} is the GHL store the CIO already
 * observed ("northside patios", "sw fencing"). Scoped ids only, same 429
 * retry and concurrency as the thread sweep — not one call per open CRM row.
 */
async function readContactsLive(
  contactIds: string[],
  retry: GhlRetryHooks = {},
): Promise<Record<string, SalesBookingContactFact>> {
  const unique = [...new Set(contactIds.filter((id) => id.length > 0))];
  const facts: Record<string, SalesBookingContactFact> = {};
  let cursor = 0;
  const now = retry.now ?? (() => new Date());
  const worker = async () => {
    for (;;) {
      if (
        retry.deadlineMs != null && now().getTime() >= retry.deadlineMs
      ) {
        return;
      }
      const index = cursor++;
      if (index >= unique.length) return;
      const contactId = unique[index];
      try {
        const body = await ghlRead(
          `/contacts/${encodeURIComponent(contactId)}`,
          {},
          retry,
        );
        facts[contactId] = salesBookingContactFactFromGhl(body);
      } catch {
        // One unread contact stays `"not given"`; do not empty the book.
      }
    }
  };
  if (unique.length > 0) {
    await Promise.all(
      Array.from({
        length: Math.min(SALES_BOOKING_THREAD_CONCURRENCY, unique.length),
      }, () => worker()),
    );
  }
  return facts;
}

const JOB_SITE_ID_CHUNK = 25;

function chunkSalesBookingIds(
  ids: string[],
  size = JOB_SITE_ID_CHUNK,
): string[][] {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    out.push(unique.slice(i, i + size));
  }
  return out;
}

/**
 * Recorded `jobs.site_suburb` / `site_address` for scoped GHL ids. One
 * bounded read per id chunk. A failed chunk leaves those keys absent so
 * the GHL contact answer still stands.
 */
async function readJobSitesLive(
  client: SalesBookingReadClient,
  opportunityIds: string[],
  contactIds: string[],
): Promise<Record<string, SalesBookingJobSiteFact>> {
  const facts: Record<string, SalesBookingJobSiteFact> = {};
  const take = (rows: Array<Record<string, unknown>> | null) => {
    for (const row of rows || []) {
      const fact: SalesBookingJobSiteFact = {
        suburb: row.site_suburb,
        address: row.site_address,
      };
      const opportunityId = nonemptyText(row.ghl_opportunity_id);
      const contactId = nonemptyText(row.ghl_contact_id);
      if (opportunityId) facts[opportunityId] = fact;
      if (contactId) facts[contactId] = fact;
    }
  };
  for (const chunk of chunkSalesBookingIds(opportunityIds)) {
    const { data, error } = await client
      .from("jobs")
      .select("ghl_opportunity_id, ghl_contact_id, site_suburb, site_address")
      .in("ghl_opportunity_id", chunk);
    if (error) continue;
    take(data as Array<Record<string, unknown>> | null);
  }
  for (const chunk of chunkSalesBookingIds(contactIds)) {
    const { data, error } = await client
      .from("jobs")
      .select("ghl_opportunity_id, ghl_contact_id, site_suburb, site_address")
      .in("ghl_contact_id", chunk);
    if (error) continue;
    take(data as Array<Record<string, unknown>> | null);
  }
  return facts;
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
export async function readSalesBookingOpportunities(args: {
  ghlGet: (
    path: string,
    init?: RequestInit,
  ) => Promise<Record<string, unknown>>;
  pipelineId: string;
  locationId: string;
  now?: () => Date;
  deadlineMs?: number;
  startAfter?: string | number | null;
  startAfterId?: string | null;
}): Promise<SalesBookingOpportunityScan> {
  const now = args.now ?? (() => new Date());
  const limit = SALES_BOOKING_OPPORTUNITY_PAGE_SIZE;
  const opportunities: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let startAfter: string | number | null = rosterCursorValue(args.startAfter);
  let startAfterId: string | null = nonemptyText(args.startAfterId);
  let pages = 0;
  let total: number | null = null;
  let exhausted = false;
  let reason: string | null = null;
  let remaining429 = 0;

  try {
    for (let page = 1; page <= SALES_BOOKING_MAX_OPPORTUNITY_PAGES; page++) {
      if (
        args.deadlineMs != null && now().getTime() >= args.deadlineMs
      ) {
        reason = "time budget exhausted";
        break;
      }
      const query = new URLSearchParams({
        locationId: args.locationId,
        limit: String(limit),
        pipelineId: args.pipelineId,
        status: "open",
      });
      if (startAfter != null) query.set("startAfter", String(startAfter));
      if (startAfterId) query.set("startAfterId", startAfterId);
      const data = await args.ghlGet(
        `/opportunities/search?${query.toString()}`,
        { headers: { Version: "v3" } },
      );
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
    if (!exhausted && !reason && pages >= SALES_BOOKING_MAX_OPPORTUNITY_PAGES) {
      reason = `page cap ${SALES_BOOKING_MAX_OPPORTUNITY_PAGES} reached`;
    }
  } catch (error) {
    reason = (error as Error)?.message || "opportunity search failed";
    if (isSalesBookingGhl429(error)) remaining429 = 1;
  }

  let stages: Record<string, string> = {};
  if (
    args.deadlineMs == null || now().getTime() < args.deadlineMs
  ) {
    try {
      const data = await args.ghlGet(
        `/opportunities/pipelines?locationId=${
          encodeURIComponent(args.locationId)
        }`,
      );
      const pipelines = Array.isArray(data.pipelines)
        ? data.pipelines as Record<string, unknown>[]
        : [];
      for (const pipeline of pipelines) {
        if (pipeline.id !== args.pipelineId) continue;
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
      stages = {};
    }
  }

  return {
    opportunities,
    stages,
    exhausted,
    pages_scanned: pages,
    total,
    reason,
    source: "live",
    age_ms: 0,
    remaining_429_count: remaining429,
    start_after: exhausted ? null : startAfter,
    start_after_id: exhausted ? null : startAfterId,
  };
}

async function readOpportunitiesLive(
  pipelineId: string,
  retry: GhlRetryHooks = {},
  resume?: {
    startAfter?: string | number | null;
    startAfterId?: string | null;
  },
): Promise<SalesBookingOpportunityScan> {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  return await readSalesBookingOpportunities({
    ghlGet: (path, init) => ghlRead(path, init, retry),
    pipelineId,
    locationId,
    now: retry.now,
    deadlineMs: retry.deadlineMs,
    startAfter: resume?.startAfter,
    startAfterId: resume?.startAfterId,
  });
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
  retry: GhlRetryHooks = {},
): Promise<SalesBookingMessage[]> {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  return await readSalesBookingThreadMessages(
    (path) => ghlRead(path, {}, retry),
    contactId,
    locationId,
  );
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
  extra: {
    calendar_email?: string | null;
    ghl_user_id?: string | null;
    mapped_by?: "email" | "name" | null;
  } = {},
): SalesBookingDiaryScan {
  return {
    read_ok: false,
    reason,
    entries: [],
    malformed_dropped: 0,
    calendar_email: extra.calendar_email ?? null,
    ghl_user_id: extra.ghl_user_id ?? null,
    mapped_by: extra.mapped_by ?? null,
    scoper_user_id: scoperUserId,
  };
}

/**
 * The scoper's GHL calendar for the window. Mapping and unread reasons:
 * `docs/sales-booking-read-contract-2026-09-16.md`. Never invents an id
 * and never treats an unread week as free. Never throws.
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
  const confirmed = confirmSalesBookingGhlUser({
    users: users.users,
    email: mapping.email,
    nameMatch: SALES_BOOKING_GHL_USERS[mapping.resource_id]?.name_match ?? null,
    claimedId: mapping.ghl_user_id,
  });
  if (!confirmed.id) {
    return unreadDiary(
      args.scoperUserId,
      confirmed.reason || "ghl_user_unmapped",
      { calendar_email: mapping.email },
    );
  }
  const calendarEmail = confirmed.ghl_email || mapping.email;

  const startMs = Date.parse(args.since);
  const untilMs = Date.parse(args.untilExclusive);
  if (
    !Number.isFinite(startMs) || !Number.isFinite(untilMs) || untilMs <= startMs
  ) {
    return unreadDiary(args.scoperUserId, "ghl_calendar_window_invalid", {
      calendar_email: calendarEmail,
      ghl_user_id: confirmed.id,
      mapped_by: confirmed.match,
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
      {
        calendar_email: calendarEmail,
        ghl_user_id: confirmed.id,
        mapped_by: confirmed.match,
      },
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
    reason: confirmed.match === "name" ? "ghl_user_mapped_by_name" : null,
    entries,
    malformed_dropped: dropped,
    calendar_email: calendarEmail,
    ghl_user_id: confirmed.id,
    mapped_by: confirmed.match,
    scoper_user_id: args.scoperUserId,
  };
}

async function readDiaryLive(
  resourceId: string,
  scoperUserId: string,
  since: string,
  untilExclusive: string,
  retry: GhlRetryHooks = {},
): Promise<SalesBookingDiaryScan> {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  return await readSalesBookingGhlDiary({
    ghlGet: (path) => ghlRead(path, {}, retry),
    locationId,
    resourceId,
    scoperUserId,
    since,
    untilExclusive,
  });
}

async function loadThreadFactsCacheLive(
  client: SalesBookingReadClient,
  resourceId: string,
): Promise<Record<string, SalesBookingCachedThreadFact>> {
  const { data, error } = await client
    .from("sales_booking_packs")
    .select("payload")
    .eq("resource", resourceId)
    .eq("week_start", SALES_BOOKING_THREAD_FACTS_WEEK_START)
    .eq("kind", SALES_BOOKING_THREAD_FACTS_KIND)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message || "thread_facts load failed");
  }
  if (!data) return {};
  return parseSalesBookingThreadFactsCache(
    (data as { payload?: unknown }).payload,
  );
}

function salesBookingThreadFactsMapsEqual(
  left: Record<string, SalesBookingCachedThreadFact>,
  right: Record<string, SalesBookingCachedThreadFact>,
): boolean {
  const a = parseSalesBookingThreadFactsCache({ facts: left });
  const b = parseSalesBookingThreadFactsCache({ facts: right });
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, index) =>
    key === keysB[index] &&
    JSON.stringify(a[key]) === JSON.stringify(b[key])
  );
}

/** One latest thread_facts row: abort on load error, merge, skip when equal, prune only older as_of. */
async function persistThreadFactsCacheLive(
  client: SalesBookingReadClient,
  resourceId: string,
  facts: Record<string, SalesBookingCachedThreadFact>,
): Promise<void> {
  let existing: Record<string, SalesBookingCachedThreadFact>;
  try {
    existing = await loadThreadFactsCacheLive(client, resourceId);
  } catch {
    return;
  }
  const merged = { ...existing, ...facts };
  if (salesBookingThreadFactsMapsEqual(existing, merged)) return;
  const asOf = new Date().toISOString();
  const { error } = await client.from("sales_booking_packs").upsert({
    resource: resourceId,
    week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
    kind: SALES_BOOKING_THREAD_FACTS_KIND,
    as_of: asOf,
    payload: { facts: merged },
    published_by: "ops-api:thread_facts",
  }, { onConflict: "resource,week_start,kind,as_of" });
  if (error) {
    throw new Error(error.message || "thread_facts persist failed");
  }
  const { error: pruneError } = await client
    .from("sales_booking_packs")
    .delete()
    .eq("resource", resourceId)
    .eq("week_start", SALES_BOOKING_THREAD_FACTS_WEEK_START)
    .eq("kind", SALES_BOOKING_THREAD_FACTS_KIND)
    .lt("as_of", asOf);
  if (pruneError) {
    throw new Error(pruneError.message || "thread_facts prune failed");
  }
}

async function loadRosterCacheLive(
  client: SalesBookingReadClient,
  resourceId: string,
): Promise<SalesBookingCachedRoster | null> {
  const { data, error } = await client
    .from("sales_booking_packs")
    .select("payload")
    .eq("resource", resourceId)
    .eq("week_start", SALES_BOOKING_THREAD_FACTS_WEEK_START)
    .eq("kind", SALES_BOOKING_ROSTER_KIND)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message || "roster load failed");
  }
  if (!data) return null;
  return parseSalesBookingRosterCache(
    (data as { payload?: unknown }).payload,
  );
}

function salesBookingRostersEqual(
  left: SalesBookingCachedRoster | null,
  right: SalesBookingCachedRoster,
): boolean {
  if (!left) return false;
  const a = parseSalesBookingRosterCache(left);
  const b = parseSalesBookingRosterCache(right);
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One latest roster row per resource at the weekless sentinel: abort on load error, skip when equal, prune only older as_of. */
async function persistRosterCacheLive(
  client: SalesBookingReadClient,
  resourceId: string,
  roster: SalesBookingCachedRoster,
): Promise<void> {
  let existing: SalesBookingCachedRoster | null;
  try {
    existing = await loadRosterCacheLive(client, resourceId);
  } catch {
    return;
  }
  if (salesBookingRostersEqual(existing, roster)) return;
  const asOf = new Date().toISOString();
  const { error } = await client.from("sales_booking_packs").upsert({
    resource: resourceId,
    week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
    kind: SALES_BOOKING_ROSTER_KIND,
    as_of: asOf,
    payload: roster,
    published_by: "ops-api:roster",
  }, { onConflict: "resource,week_start,kind,as_of" });
  if (error) {
    throw new Error(error.message || "roster persist failed");
  }
  const { error: pruneError } = await client
    .from("sales_booking_packs")
    .delete()
    .eq("resource", resourceId)
    .eq("week_start", SALES_BOOKING_THREAD_FACTS_WEEK_START)
    .eq("kind", SALES_BOOKING_ROSTER_KIND)
    .lt("as_of", asOf);
  if (pruneError) {
    throw new Error(pruneError.message || "roster prune failed");
  }
}

/** Real readers for the dispatch. Cache persist is the only write. */
export function createSalesBookingReadDependencies(
  client: SalesBookingReadClient,
): SalesBookingReadDependencies {
  const retry: GhlRetryHooks = {
    now: () => new Date(),
  };
  return {
    readOpportunities: (
      { pipelineId, deadlineMs, startAfter, startAfterId },
    ) => {
      retry.deadlineMs = deadlineMs;
      return readOpportunitiesLive(pipelineId, retry, {
        startAfter,
        startAfterId,
      });
    },
    readDiary: (
      { resourceId, scoperUserId, since, untilExclusive, deadlineMs },
    ) => {
      retry.deadlineMs = deadlineMs;
      return readDiaryLive(
        resourceId,
        scoperUserId,
        since,
        untilExclusive,
        retry,
      );
    },
    readThread: ({ contactId, deadlineMs }) => {
      if (deadlineMs != null) retry.deadlineMs = deadlineMs;
      return readThreadLive(contactId, retry);
    },
    readContacts: (contactIds, opts) => {
      if (opts?.deadlineMs != null) retry.deadlineMs = opts.deadlineMs;
      return readContactsLive(contactIds, retry);
    },
    readJobSites: ({ opportunityIds, contactIds }) =>
      readJobSitesLive(client, opportunityIds, contactIds),
    now: () => new Date(),
    loadThreadFactsCache: (resourceId) =>
      loadThreadFactsCacheLive(client, resourceId),
    persistThreadFactsCache: (resourceId, facts) =>
      persistThreadFactsCacheLive(client, resourceId, facts),
    loadRosterCache: (resourceId) => loadRosterCacheLive(client, resourceId),
    persistRosterCache: (resourceId, roster) =>
      persistRosterCacheLive(client, resourceId, roster),
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
