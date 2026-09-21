// ════════════════════════════════════════════════════════════
// GHL calendar events — read-only
// ════════════════════════════════════════════════════════════
//
// Read-only GHL calendar GETs: calendar_events (one /calendars/events
// window), calendar_directory, calendar_person_events. Selectors, scoper
// allowlist, null-id mapping, and complete/unread rules:
// `docs/sales-booking-read-contract-2026-09-16.md`. No writes of any kind.
//
// Times on the actions are ISO (Perth). GHL itself wants Unix milliseconds;
// conversion happens here so callers never have to know that.

export interface GhlCalendarGet {
  (path: string): Promise<Record<string, unknown>>;
}

export interface GhlCalendarEventsScan {
  events: Record<string, unknown>[];
  count: number;
  failure: string | null;
  user_id: string | null;
  calendar_id: string | null;
  start_ms: number;
  end_ms: number;
}

/**
 * Exact-id map next to the calendar read. Null ghl_user_id / calendar_id
 * means unconfirmed — never a known id and never a guessed calendar.
 * Filling those ids is the later owner-approved configuration change after
 * discovery.
 */
export interface SalesBookingScoperCalendar {
  email: string;
  purpose: string;
  ghl_user_id: string | null;
  calendar_id: string | null;
}

export const SALES_BOOKING_SCOPER_CALENDARS:
  readonly SalesBookingScoperCalendar[] = [
    {
      email: "marnin@secureworkswa.com.au",
      purpose: "Stratco visits",
      ghl_user_id: null,
      calendar_id: null,
    },
    {
      email: "khairo@secureworkswa.com.au",
      purpose: "fencing enquiries",
      ghl_user_id: null,
      calendar_id: null,
    },
    {
      email: "nithin@secureworkswa.com.au",
      purpose: "patios",
      ghl_user_id: null,
      calendar_id: null,
    },
  ];

export function salesBookingScoperCalendar(
  email: string,
): SalesBookingScoperCalendar | null {
  const normalised = nonempty(email)?.toLowerCase() ?? null;
  if (!normalised) return null;
  return SALES_BOOKING_SCOPER_CALENDARS.find((row) =>
    row.email === normalised
  ) ?? null;
}

function dedicatedCalendarProvenance(
  scoper: SalesBookingScoperCalendar,
): {
  calendar_purpose: string;
  dedicated_calendar_id: string | null;
  dedicated_calendar: "confirmed" | "unconfirmed";
} {
  const calendarId = ghlId(scoper.calendar_id);
  return {
    calendar_purpose: scoper.purpose,
    dedicated_calendar_id: calendarId,
    dedicated_calendar: calendarId ? "confirmed" : "unconfirmed",
  };
}

function refuseNonScoperEmail(): GhlCalendarEventsActionResult {
  return {
    status: 400,
    body: {
      ok: false,
      error: "user_email is not a mapped scoper address",
      code: "scoper_email_required",
    },
  };
}

export interface GhlLocationUser {
  id: string;
  email: string | null;
  name: string | null;
  firstName: string | null;
}

export interface GhlLocationUsersScan {
  users: GhlLocationUser[];
  failure: string | null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ghlId(value: unknown): string | null {
  const id = nonempty(value);
  if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return null;
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventsAssignedToUser(
  events: Record<string, unknown>[],
  userId: string,
): Record<string, unknown>[] {
  return events.filter((event) => {
    const assigned = ghlId(event.assignedUserId);
    return !assigned || assigned === userId;
  });
}

/** Perth ISO or Unix-ms into the millis GHL calendars/events requires. */
export function ghlCalendarInstantMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const text = nonempty(value);
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function eventsFromBody(
  body: Record<string, unknown>,
): Record<string, unknown>[] {
  return Array.isArray(body.events)
    ? body.events as Record<string, unknown>[]
    : [];
}

/**
 * One documented `/calendars/events` window GET. Never throws: a failed GET
 * is `failure` plus zero events, so a caller cannot treat an unread week as
 * a free week.
 */
export async function fetchGhlCalendarEvents(args: {
  ghlGet: GhlCalendarGet;
  locationId: string;
  userId?: string | null;
  calendarId?: string | null;
  startMs: number;
  endMs: number;
}): Promise<GhlCalendarEventsScan> {
  const userId = ghlId(args.userId);
  const calendarId = ghlId(args.calendarId);

  if (!userId && !calendarId) {
    return {
      events: [],
      count: 0,
      failure: "user_or_calendar_required",
      user_id: null,
      calendar_id: null,
      start_ms: args.startMs,
      end_ms: args.endMs,
    };
  }

  try {
    const query = new URLSearchParams({
      locationId: args.locationId,
      startTime: String(args.startMs),
      endTime: String(args.endMs),
    });
    if (userId) query.set("userId", userId);
    if (calendarId) query.set("calendarId", calendarId);
    const body = await args.ghlGet(`/calendars/events?${query.toString()}`);
    const events = eventsFromBody(body);
    return {
      events,
      count: events.length,
      failure: null,
      user_id: userId,
      calendar_id: calendarId,
      start_ms: args.startMs,
      end_ms: args.endMs,
    };
  } catch (error) {
    let failure = (error as Error)?.message || "ghl_calendar_page_failed";
    if (!failure.startsWith("ghl_calendar_")) {
      failure = `ghl_calendar_page_failed: ${failure}`;
    }
    return {
      events: [],
      count: 0,
      failure,
      user_id: userId,
      calendar_id: calendarId,
      start_ms: args.startMs,
      end_ms: args.endMs,
    };
  }
}

/**
 * A documented empty `users` array is a valid empty roster. A missing,
 * wrong-type, or malformed field is `ghl_users_malformed`.
 */
export function usersFromGhlBody(
  body: Record<string, unknown>,
): GhlLocationUsersScan {
  if (!Array.isArray(body.users)) {
    return { users: [], failure: "ghl_users_malformed" };
  }
  const users: GhlLocationUser[] = [];
  for (const row of body.users as unknown[]) {
    if (!isRecord(row)) {
      return { users: [], failure: "ghl_users_malformed" };
    }
    const id = ghlId(row.id);
    if (!id) {
      return { users: [], failure: "ghl_users_malformed" };
    }
    users.push({
      id,
      email: nonempty(row.email)?.toLowerCase() ?? null,
      name: nonempty(row.name),
      firstName: nonempty(row.firstName),
    });
  }
  return { users, failure: null };
}

/** GET /users/?locationId= — no companyId, matches the ghl-proxy 2021-07-28 lane. */
export async function fetchGhlLocationUsers(args: {
  ghlGet: GhlCalendarGet;
  locationId: string;
}): Promise<GhlLocationUsersScan> {
  try {
    const body = await args.ghlGet(
      `/users/?locationId=${encodeURIComponent(args.locationId)}`,
    );
    return usersFromGhlBody(body);
  } catch (error) {
    return {
      users: [],
      failure: `ghl_users_unread: ${(error as Error)?.message || "unknown"}`,
    };
  }
}

/**
 * Confirm a GHL user id against the live location roster. Zero or several
 * email matches cannot be confirmed, so the caller must not invent an id.
 */
export function confirmGhlUserId(args: {
  users: GhlLocationUser[];
  email: string;
  claimedId?: string | null;
}): { id: string | null; reason: string | null } {
  const email = args.email.trim().toLowerCase();
  if (!email) return { id: null, reason: "ghl_user_unmapped" };
  const matches = args.users.filter((user) => user.email === email);
  if (matches.length !== 1) return { id: null, reason: "ghl_user_unmapped" };
  const id = matches[0].id;
  const claimed = ghlId(args.claimedId);
  if (claimed && claimed !== id) {
    return { id: null, reason: "ghl_user_unmapped" };
  }
  return { id, reason: null };
}

export interface GhlCalendarEventsActionResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Read-only ghl-proxy action. GET only. Never writes. A provider failure is
 * 200 with provenance.failure set rather than an empty 200 that looks like a
 * free week to a careless caller — `ok` is false when the GET failed.
 */
export async function ghlCalendarEventsAction(args: {
  method: string;
  params: URLSearchParams;
  locationId: string;
  ghlGet: GhlCalendarGet;
}): Promise<GhlCalendarEventsActionResult> {
  if (args.method !== "GET") {
    return {
      status: 405,
      body: {
        ok: false,
        error: "calendar_events is GET only",
        code: "method_not_allowed",
      },
    };
  }
  const userId = ghlId(args.params.get("userId"));
  const calendarId = ghlId(args.params.get("calendarId"));
  const userEmail = nonempty(args.params.get("user_email"))?.toLowerCase() ??
    null;
  const selectorCount = [userId, calendarId, userEmail].filter(Boolean).length;
  if (selectorCount === 0) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "userId, calendarId, or user_email is required",
        code: "user_or_calendar_required",
      },
    };
  }
  if (selectorCount > 1) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "exactly one of userId, calendarId, user_email",
        code: "exactly_one_selector",
      },
    };
  }
  const startMs = ghlCalendarInstantMs(args.params.get("start"));
  const endMs = ghlCalendarInstantMs(args.params.get("end"));
  if (startMs === null || endMs === null || endMs <= startMs) {
    return {
      status: 400,
      body: {
        ok: false,
        error:
          "start and end must be ISO (Perth) or Unix milliseconds, with end after start",
        code: "invalid_window",
      },
    };
  }

  let resolvedUserId = userId;
  let emailProvenance: Record<string, unknown> | null = null;
  if (userEmail) {
    const scoper = salesBookingScoperCalendar(userEmail);
    if (!scoper) return refuseNonScoperEmail();
    const dedicated = dedicatedCalendarProvenance(scoper);
    const roster = await fetchGhlLocationUsers({
      ghlGet: args.ghlGet,
      locationId: args.locationId,
    });
    if (roster.failure) {
      return unreadEmailCalendar({
        userEmail,
        failure: roster.failure,
        startMs,
        endMs,
        dedicated,
      });
    }
    const confirmed = confirmGhlUserId({
      users: roster.users,
      email: userEmail,
      claimedId: scoper.ghl_user_id,
    });
    if (!confirmed.id) {
      return unreadEmailCalendar({
        userEmail,
        failure: confirmed.reason || "ghl_user_unmapped",
        startMs,
        endMs,
        dedicated,
      });
    }
    resolvedUserId = confirmed.id;
    emailProvenance = {
      user_email: userEmail,
      user_id_resolved_by: "roster_email_match",
      ...dedicated,
    };
  }

  const scan = await fetchGhlCalendarEvents({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
    userId: resolvedUserId,
    calendarId,
    startMs,
    endMs,
  });
  return {
    status: 200,
    body: {
      ok: scan.failure === null,
      events: scan.events,
      provenance: {
        count: scan.count,
        failure: scan.failure,
        user_id: scan.user_id,
        calendar_id: scan.calendar_id,
        start_ms: scan.start_ms,
        end_ms: scan.end_ms,
        ...(emailProvenance ?? {}),
      },
    },
  };
}

function unreadEmailCalendar(args: {
  userEmail: string;
  failure: string;
  startMs: number;
  endMs: number;
  dedicated?: ReturnType<typeof dedicatedCalendarProvenance>;
}): GhlCalendarEventsActionResult {
  return {
    status: 200,
    body: {
      ok: false,
      events: [],
      provenance: {
        count: 0,
        failure: args.failure,
        user_id: null,
        calendar_id: null,
        start_ms: args.startMs,
        end_ms: args.endMs,
        user_email: args.userEmail,
        ...(args.dedicated ?? {}),
      },
    },
  };
}

export interface GhlCalendarDirectoryRow {
  id: string;
  name: string | null;
  is_active: boolean | null;
  assigned_user_ids: string[];
  assignments_returned: boolean;
}

export interface GhlProviderReadReceipt {
  ok: boolean;
  count: number;
  failure: string | null;
}

export interface GhlCalendarsScan {
  calendars: GhlCalendarDirectoryRow[];
  receipt: GhlProviderReadReceipt;
}

/**
 * Documented GET /calendars/?locationId=. The list schema names id, name,
 * isActive; teamMembers is a create/update field. A missing or wrong-type
 * `calendars` field is `ghl_calendars_malformed`, not an empty list. When a
 * row has no teamMembers array, assignments_returned is false — never
 * inferred from events. A malformed assignment row also marks
 * assignments_returned false.
 */
export function calendarsFromGhlBody(
  body: Record<string, unknown>,
): { calendars: GhlCalendarDirectoryRow[]; failure: string | null } {
  if (!Array.isArray(body.calendars)) {
    return { calendars: [], failure: "ghl_calendars_malformed" };
  }
  const calendars: GhlCalendarDirectoryRow[] = [];
  for (const row of body.calendars as unknown[]) {
    if (!isRecord(row)) {
      return { calendars: [], failure: "ghl_calendars_malformed" };
    }
    const id = ghlId(row.id);
    if (!id) {
      return { calendars: [], failure: "ghl_calendars_malformed" };
    }
    const teamMembers = row.teamMembers;
    let assignmentsReturned = Array.isArray(teamMembers);
    const assigned: string[] = [];
    if (assignmentsReturned) {
      const seen = new Set<string>();
      for (const member of teamMembers as unknown[]) {
        if (!isRecord(member)) {
          assignmentsReturned = false;
          assigned.length = 0;
          break;
        }
        const userId = ghlId(member.userId);
        if (!userId) {
          assignmentsReturned = false;
          assigned.length = 0;
          break;
        }
        if (seen.has(userId)) continue;
        seen.add(userId);
        assigned.push(userId);
      }
    }
    calendars.push({
      id,
      name: nonempty(row.name),
      is_active: typeof row.isActive === "boolean" ? row.isActive : null,
      assigned_user_ids: assigned,
      assignments_returned: assignmentsReturned,
    });
  }
  return { calendars, failure: null };
}

export async function fetchGhlCalendars(args: {
  ghlGet: GhlCalendarGet;
  locationId: string;
}): Promise<GhlCalendarsScan> {
  try {
    const body = await args.ghlGet(
      `/calendars/?locationId=${encodeURIComponent(args.locationId)}`,
    );
    const parsed = calendarsFromGhlBody(body);
    if (parsed.failure) {
      return {
        calendars: [],
        receipt: { ok: false, count: 0, failure: parsed.failure },
      };
    }
    return {
      calendars: parsed.calendars,
      receipt: { ok: true, count: parsed.calendars.length, failure: null },
    };
  } catch (error) {
    return {
      calendars: [],
      receipt: {
        ok: false,
        count: 0,
        failure: `ghl_calendars_unread: ${
          (error as Error)?.message || "unknown"
        }`,
      },
    };
  }
}

function rosterUsersFromScan(
  users: GhlLocationUser[],
): Array<{ id: string; name: string | null; email: string | null }> {
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
  }));
}

/**
 * GET calendar_directory — location calendars plus the user roster.
 * Two independent provider reads, each with its own receipt. GET only.
 */
export async function ghlCalendarDirectoryAction(args: {
  method: string;
  locationId: string;
  ghlGet: GhlCalendarGet;
}): Promise<GhlCalendarEventsActionResult> {
  if (args.method !== "GET") {
    return {
      status: 405,
      body: {
        ok: false,
        error: "calendar_directory is GET only",
        code: "method_not_allowed",
      },
    };
  }
  const calendars = await fetchGhlCalendars({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
  });
  const users = await fetchGhlLocationUsers({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
  });
  const usersReceipt: GhlProviderReadReceipt = users.failure
    ? { ok: false, count: 0, failure: users.failure }
    : { ok: true, count: users.users.length, failure: null };
  return {
    status: 200,
    body: {
      ok: calendars.receipt.ok && usersReceipt.ok,
      calendars: calendars.calendars,
      users: users.failure ? [] : rosterUsersFromScan(users.users),
      provenance: {
        calendars: calendars.receipt,
        users: usersReceipt,
      },
    },
  };
}

export interface GhlCalendarReadReceipt extends GhlProviderReadReceipt {
  calendar_id: string;
  name: string | null;
}

function eventId(event: Record<string, unknown>): string | null {
  return nonempty(event.id);
}

function mergeEventsById(
  batches: Array<Record<string, unknown>[]>,
): { events: Record<string, unknown>[]; deduplicated: number } {
  const events: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let deduplicated = 0;
  for (const batch of batches) {
    for (const event of batch) {
      const id = eventId(event);
      if (id) {
        if (seen.has(id)) {
          deduplicated += 1;
          continue;
        }
        seen.add(id);
      }
      events.push(event);
    }
  }
  return { events, deduplicated };
}

/**
 * GET calendar_person_events — one scoper's events across assigned calendars
 * plus their userId window. Assigned-calendar reads pass that userId so a
 * shared calendar cannot bleed another assignee. A failed or malformed
 * constituent read marks complete false and still returns the others. GET
 * only. Never writes.
 */
export async function ghlCalendarPersonEventsAction(args: {
  method: string;
  params: URLSearchParams;
  locationId: string;
  ghlGet: GhlCalendarGet;
}): Promise<GhlCalendarEventsActionResult> {
  if (args.method !== "GET") {
    return {
      status: 405,
      body: {
        ok: false,
        error: "calendar_person_events is GET only",
        code: "method_not_allowed",
      },
    };
  }
  const userEmail = nonempty(args.params.get("user_email"))?.toLowerCase() ??
    null;
  if (!userEmail) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "user_email is required",
        code: "user_email_required",
      },
    };
  }
  const scoper = salesBookingScoperCalendar(userEmail);
  if (!scoper) return refuseNonScoperEmail();
  const dedicated = dedicatedCalendarProvenance(scoper);
  const startMs = ghlCalendarInstantMs(args.params.get("start"));
  const endMs = ghlCalendarInstantMs(args.params.get("end"));
  if (startMs === null || endMs === null || endMs <= startMs) {
    return {
      status: 400,
      body: {
        ok: false,
        error:
          "start and end must be ISO (Perth) or Unix milliseconds, with end after start",
        code: "invalid_window",
      },
    };
  }

  const users = await fetchGhlLocationUsers({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
  });
  if (users.failure) {
    return {
      status: 200,
      body: {
        ok: false,
        complete: false,
        events: [],
        provenance: {
          user_email: userEmail,
          user_id: null,
          failure: users.failure,
          complete: false,
          ...dedicated,
        },
      },
    };
  }
  const confirmed = confirmGhlUserId({
    users: users.users,
    email: userEmail,
    claimedId: scoper.ghl_user_id,
  });
  if (!confirmed.id) {
    return {
      status: 200,
      body: {
        ok: false,
        complete: false,
        events: [],
        provenance: {
          user_email: userEmail,
          user_id: null,
          failure: confirmed.reason || "ghl_user_unmapped",
          complete: false,
          ...dedicated,
        },
      },
    };
  }
  const resolvedUserId = confirmed.id;

  const calendars = await fetchGhlCalendars({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
  });
  const assignmentsReturned = calendars.receipt.ok &&
    calendars.calendars.every((row) => row.assignments_returned);
  const assigned = assignmentsReturned
    ? calendars.calendars.filter((row) =>
      row.assigned_user_ids.includes(resolvedUserId)
    )
    : [];

  const userScan = await fetchGhlCalendarEvents({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
    userId: resolvedUserId,
    startMs,
    endMs,
  });
  const userEventsReceipt: GhlProviderReadReceipt = {
    ok: userScan.failure === null,
    count: userScan.count,
    failure: userScan.failure,
  };

  const calendarReads: GhlCalendarReadReceipt[] = [];
  const calendarBatches: Array<Record<string, unknown>[]> = [];
  for (const calendar of assigned) {
    const scan = await fetchGhlCalendarEvents({
      ghlGet: args.ghlGet,
      locationId: args.locationId,
      userId: resolvedUserId,
      calendarId: calendar.id,
      startMs,
      endMs,
    });
    const kept = eventsAssignedToUser(scan.events, resolvedUserId);
    calendarReads.push({
      calendar_id: calendar.id,
      name: calendar.name,
      ok: scan.failure === null,
      count: scan.failure === null ? kept.length : scan.count,
      failure: scan.failure,
    });
    calendarBatches.push(kept);
  }

  const merged = mergeEventsById([
    eventsAssignedToUser(userScan.events, resolvedUserId),
    ...calendarBatches,
  ]);
  const complete = userEventsReceipt.ok && calendars.receipt.ok &&
    assignmentsReturned &&
    calendarReads.every((row) => row.ok);
  return {
    status: 200,
    body: {
      ok: complete,
      complete,
      events: merged.events,
      provenance: {
        user_email: userEmail,
        user_id: resolvedUserId,
        user_id_resolved_by: "roster_email_match",
        ...dedicated,
        start_ms: startMs,
        end_ms: endMs,
        complete,
        count: merged.events.length,
        deduplicated: merged.deduplicated,
        assignments_returned: assignmentsReturned,
        calendars_list: calendars.receipt,
        user_events: userEventsReceipt,
        calendar_reads: calendarReads,
      },
    },
  };
}
