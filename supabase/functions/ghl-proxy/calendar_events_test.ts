/**
 * ghl-proxy calendar_events — read-only paging and provenance.
 *
 * What these prove: GET-only, user-or-calendar required, ISO window, paging to
 * a short page, a failed GHL page named in provenance, users-list confirmation
 * that refuses a guess. No writes, no live GHL.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  confirmGhlUserId,
  fetchGhlCalendarEvents,
  fetchGhlLocationUsers,
  GHL_CALENDAR_EVENTS_PAGE_SIZE,
  ghlCalendarEventsAction,
  ghlCalendarInstantMs,
  usersFromGhlBody,
} from "./calendar_events.ts";

const LOCATION = "loc_secureworks";
const USER = "ghl_user_nithin";
const START = Date.parse("2026-09-14T00:00:00+08:00");
const END = Date.parse("2026-09-21T00:00:00+08:00") - 1;

function event(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Event ${id}`,
    appointmentStatus: "confirmed",
    startTime: "2026-09-15T10:00:00+08:00",
    endTime: "2026-09-15T11:00:00+08:00",
    assignedUserId: USER,
    ...extra,
  };
}

function getter(
  replies: Array<
    | Record<string, unknown>
    | { throw: string }
  >,
) {
  const calls: string[] = [];
  const ghlGet = (path: string) => {
    calls.push(path);
    const reply = replies[calls.length - 1];
    if (!reply) return Promise.reject(new Error(`unexpected GHL GET ${path}`));
    if ("throw" in reply && typeof reply.throw === "string") {
      return Promise.reject(new Error(reply.throw));
    }
    return Promise.resolve(reply);
  };
  return { calls, ghlGet };
}

Deno.test("ghlCalendarInstantMs accepts Perth ISO and Unix milliseconds", () => {
  assertEquals(
    ghlCalendarInstantMs("2026-09-14T00:00:00+08:00"),
    START,
  );
  assertEquals(ghlCalendarInstantMs(START), START);
  assertEquals(ghlCalendarInstantMs(String(START)), START);
  assertEquals(ghlCalendarInstantMs("not-a-date"), null);
});

Deno.test("calendar_events action is GET only and requires a user or calendar plus a window", async () => {
  const { ghlGet } = getter([]);
  const post = await ghlCalendarEventsAction({
    method: "POST",
    params: new URLSearchParams(),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(post.status, 405);
  assertEquals((post.body as { code: string }).code, "method_not_allowed");

  const missing = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      start: "2026-09-14T00:00:00+08:00",
      end: "2026-09-21T00:00:00+08:00",
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(missing.status, 400);
  assertEquals(
    (missing.body as { code: string }).code,
    "user_or_calendar_required",
  );

  const badWindow = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      userId: USER,
      start: "2026-09-21T00:00:00+08:00",
      end: "2026-09-14T00:00:00+08:00",
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(badWindow.status, 400);
  assertEquals((badWindow.body as { code: string }).code, "invalid_window");
});

Deno.test("a short GHL page is completion; raw events and provenance ride the body", async () => {
  const { calls, ghlGet } = getter([{
    events: [event("a"), event("b", { appointmentStatus: "cancelled" })],
  }]);
  const result = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      userId: USER,
      start: "2026-09-14T00:00:00+08:00",
      end: "2026-09-21T00:00:00+08:00",
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals((result.body.events as unknown[]).length, 2);
  const provenance = result.body.provenance as Record<string, unknown>;
  assertEquals(provenance.pages_read, 1);
  assertEquals(provenance.count, 2);
  assertEquals(provenance.exhausted, true);
  assertEquals(provenance.failure, null);
  assertEquals(provenance.user_id, USER);
  assertStringIncludes(calls[0], "/calendars/events?");
  assertStringIncludes(calls[0], `userId=${USER}`);
  assertStringIncludes(calls[0], `locationId=${LOCATION}`);
});

Deno.test("a full page is followed; a failed later page is named and not treated as complete", async () => {
  const full = Array.from(
    { length: GHL_CALENDAR_EVENTS_PAGE_SIZE },
    (_, i) => event(`p1-${i}`),
  );
  const { ghlGet } = getter([
    { events: full },
    { throw: "GHL 502: upstream" },
  ]);
  const scan = await fetchGhlCalendarEvents({
    ghlGet,
    locationId: LOCATION,
    userId: USER,
    startMs: START,
    endMs: END,
  });
  assertEquals(scan.pages_read, 1);
  assertEquals(scan.count, GHL_CALENDAR_EVENTS_PAGE_SIZE);
  assertEquals(scan.exhausted, false);
  assertStringIncludes(scan.failure || "", "ghl_calendar_page_failed");
  assertStringIncludes(scan.failure || "", "GHL 502");
});

Deno.test("confirmGhlUserId refuses a missing, duplicate, or disagreed email match", () => {
  const users = usersFromGhlBody({
    users: [
      { id: "n1", email: "nithin@secureworkswa.com.au", name: "Nithin" },
      { id: "m1", email: "marnin@secureworkswa.com.au", name: "Marnin" },
    ],
  });
  assertEquals(
    confirmGhlUserId({ users, email: "nithin@secureworkswa.com.au" }),
    { id: "n1", reason: null },
  );
  assertEquals(
    confirmGhlUserId({ users, email: "khairo@secureworkswa.com.au" }).reason,
    "ghl_user_unmapped",
  );
  assertEquals(
    confirmGhlUserId({
      users,
      email: "nithin@secureworkswa.com.au",
      claimedId: "someone-else",
    }).reason,
    "ghl_user_unmapped",
  );
});

Deno.test("a failed users list is unread, never an invented roster", async () => {
  const { ghlGet } = getter([{ throw: "GHL 401: no token" }]);
  const scan = await fetchGhlLocationUsers({
    ghlGet,
    locationId: LOCATION,
  });
  assertEquals(scan.users, []);
  assertStringIncludes(scan.failure || "", "ghl_users_unread");
});

Deno.test("ghl-proxy index wires calendar_events as a GET action", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const action = source.indexOf("action === 'calendar_events'");
  assertEquals(action >= 0, true);
  const methodGuard = source.indexOf("req.method !== 'GET'", action);
  assertEquals(methodGuard > action, true);
  assertEquals(source.includes("ghlCalendarEventsAction"), true);
  assertEquals(
    /calendars\/events['"`].*(POST|PUT|PATCH|DELETE)/i.test(
      source.slice(action, action + 800),
    ),
    false,
  );
});
