// ════════════════════════════════════════════════════════════
// GHL calendar events — read-only
// ════════════════════════════════════════════════════════════
//
// GET ghl-proxy?action=calendar_events is the one calendar read. It pages
// `/calendars/events` for a location window filtered by userId or calendarId
// and returns the raw GHL events plus provenance. No writes of any kind.
//
// Times on the action are ISO (Perth). GHL itself wants Unix milliseconds;
// conversion happens here so callers never have to know that.

export const GHL_CALENDAR_EVENTS_PAGE_SIZE = 100;
export const GHL_CALENDAR_EVENTS_MAX_PAGES = 10;

export interface GhlCalendarGet {
  (path: string): Promise<Record<string, unknown>>;
}

export interface GhlCalendarEventsScan {
  events: Record<string, unknown>[];
  pages_read: number;
  count: number;
  exhausted: boolean;
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
  if (Array.isArray(body.events)) {
    return body.events as Record<string, unknown>[];
  }
  if (Array.isArray(body.appointments)) {
    return body.appointments as Record<string, unknown>[];
  }
  const nested = body.data && typeof body.data === "object"
    ? body.data as Record<string, unknown>
    : null;
  if (nested && Array.isArray(nested.events)) {
    return nested.events as Record<string, unknown>[];
  }
  return [];
}

function nextSkip(
  body: Record<string, unknown>,
  skip: number,
  rows: Record<string, unknown>[],
  limit: number,
): number | null {
  const meta =
    (body.meta && typeof body.meta === "object"
      ? body.meta
      : {}) as Record<string, unknown>;
  const declared = meta.nextSkip ?? meta.skip ?? body.nextSkip;
  if (typeof declared === "number" && Number.isFinite(declared)) {
    const next = Math.trunc(declared);
    return next > skip ? next : null;
  }
  if (typeof declared === "string" && /^\d+$/.test(declared)) {
    const next = Number(declared);
    return next > skip ? next : null;
  }
  if (rows.length < limit) return null;
  return skip + rows.length;
}

/**
 * Page `/calendars/events` to completion (or a named failure). Never throws:
 * a failed page is `failure` plus the events already collected, so a caller
 * can refuse to treat a partial week as a free week.
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
  const events: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let skip = 0;
  let exhausted = false;
  let failure: string | null = null;
  const limit = GHL_CALENDAR_EVENTS_PAGE_SIZE;

  if (!userId && !calendarId) {
    return {
      events: [],
      pages_read: 0,
      count: 0,
      exhausted: false,
      failure: "user_or_calendar_required",
      user_id: null,
      calendar_id: null,
      start_ms: args.startMs,
      end_ms: args.endMs,
    };
  }

  try {
    let paged = true;
    for (let page = 0; page < GHL_CALENDAR_EVENTS_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        locationId: args.locationId,
        startTime: String(args.startMs),
        endTime: String(args.endMs),
      });
      if (userId) query.set("userId", userId);
      if (calendarId) query.set("calendarId", calendarId);
      if (paged) {
        query.set("limit", String(limit));
        query.set("skip", String(skip));
      }
      let body: Record<string, unknown>;
      try {
        body = await args.ghlGet(`/calendars/events?${query.toString()}`);
      } catch (error) {
        // Documented Get Calendar Events has no skip/limit. One window retry
        // on the first page only; a later page failure stays a failure.
        if (page === 0 && paged) {
          paged = false;
          const unpaged = new URLSearchParams({
            locationId: args.locationId,
            startTime: String(args.startMs),
            endTime: String(args.endMs),
          });
          if (userId) unpaged.set("userId", userId);
          if (calendarId) unpaged.set("calendarId", calendarId);
          body = await args.ghlGet(`/calendars/events?${unpaged.toString()}`);
        } else {
          throw error;
        }
      }
      pages++;
      const rows = eventsFromBody(body);
      let fresh = 0;
      for (const row of rows) {
        const id = typeof row.id === "string" ? row.id : "";
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        events.push(row);
        fresh++;
      }
      if (!paged) {
        exhausted = true;
        break;
      }
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      const next = nextSkip(body, skip, rows, limit);
      if (next === null) {
        exhausted = true;
        break;
      }
      if (fresh === 0) {
        failure = "calendar_pagination_stalled";
        break;
      }
      skip = next;
    }
    if (!exhausted && !failure && pages >= GHL_CALENDAR_EVENTS_MAX_PAGES) {
      failure = `page cap ${GHL_CALENDAR_EVENTS_MAX_PAGES} reached`;
    }
  } catch (error) {
    failure = (error as Error)?.message || "ghl_calendar_page_failed";
    if (!failure.startsWith("ghl_calendar_")) {
      failure = `ghl_calendar_page_failed: ${failure}`;
    }
  }

  return {
    events,
    pages_read: pages,
    count: events.length,
    exhausted,
    failure,
    user_id: userId,
    calendar_id: calendarId,
    start_ms: args.startMs,
    end_ms: args.endMs,
  };
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
 * free week to a careless caller — `ok` is false when the scan did not finish.
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
  const userId = nonempty(args.params.get("userId") ?? args.params.get("user_id"));
  const calendarId = nonempty(
    args.params.get("calendarId") ?? args.params.get("calendar_id"),
  );
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
  const startMs = ghlCalendarInstantMs(
    args.params.get("start") ?? args.params.get("startTime"),
  );
  const endMs = ghlCalendarInstantMs(
    args.params.get("end") ?? args.params.get("endTime"),
  );
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
  const ok = scan.failure === null && scan.exhausted;
  return {
    status: 200,
    body: {
      ok,
      events: scan.events,
      provenance: {
        pages_read: scan.pages_read,
        count: scan.count,
        exhausted: scan.exhausted,
        failure: scan.failure,
        user_id: scan.user_id,
        calendar_id: scan.calendar_id,
        start_ms: scan.start_ms,
        end_ms: scan.end_ms,
      },
    },
  };
}
