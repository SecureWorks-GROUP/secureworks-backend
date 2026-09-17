// ════════════════════════════════════════════════════════════
// GHL calendar events — read-only
// ════════════════════════════════════════════════════════════
//
// GET ghl-proxy?action=calendar_events is the one calendar read. It issues
// one documented Get Calendar Events call (`/calendars/events` with
// locationId, userId or calendarId, startTime, endTime) and returns the raw
// GHL events plus provenance. No writes of any kind.
//
// Times on the action are ISO (Perth). GHL itself wants Unix milliseconds;
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

export interface GhlLocationUser {
  id: string;
  email: string | null;
  name: string | null;
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

function eventsFromBody(body: Record<string, unknown>): Record<string, unknown>[] {
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

export function usersFromGhlBody(
  body: Record<string, unknown>,
): GhlLocationUser[] {
  const raw = Array.isArray(body.users)
    ? body.users
    : Array.isArray(body.data)
    ? body.data
    : [];
  const users: GhlLocationUser[] = [];
  for (const row of raw as Record<string, unknown>[]) {
    const id = ghlId(row.id);
    if (!id) continue;
    users.push({
      id,
      email: nonempty(row.email)?.toLowerCase() ?? null,
      name: nonempty(row.name) ||
        nonempty(
          [row.firstName, row.lastName].filter((part) => nonempty(part)).join(
            " ",
          ),
        ),
    });
  }
  return users;
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
    return { users: usersFromGhlBody(body), failure: null };
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
  if (claimed && claimed !== id) return { id: null, reason: "ghl_user_unmapped" };
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
  const userId = nonempty(args.params.get("userId"));
  const calendarId = nonempty(args.params.get("calendarId"));
  if (!ghlId(userId) && !ghlId(calendarId)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "userId or calendarId is required",
        code: "user_or_calendar_required",
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
        error: "start and end must be ISO (Perth) or Unix milliseconds, with end after start",
        code: "invalid_window",
      },
    };
  }

  const scan = await fetchGhlCalendarEvents({
    ghlGet: args.ghlGet,
    locationId: args.locationId,
    userId,
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
      },
    },
  };
}
