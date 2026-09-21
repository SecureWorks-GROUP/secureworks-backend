/**
 * ghl-proxy calendar_events — read-only window GET and provenance.
 *
 * What these prove: GET-only, user-or-calendar required, ISO window, one
 * unpaged calendars/events GET, a failed GHL GET named in provenance,
 * users-list confirmation that refuses a guess. No writes, no live GHL.
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

function windowQuery(path: string): URLSearchParams {
  return new URL(path, "https://ghl.example").searchParams;
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

Deno.test("calendar_events accepts only userId or calendarId plus start and end", async () => {
  const { calls, ghlGet } = getter([]);
  const snake = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_id: USER,
      start: "2026-09-14T00:00:00+08:00",
      end: "2026-09-21T00:00:00+08:00",
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(snake.status, 400);
  assertEquals(
    (snake.body as { code: string }).code,
    "user_or_calendar_required",
  );

  const ghlNames = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      userId: USER,
      startTime: "2026-09-14T00:00:00+08:00",
      endTime: "2026-09-21T00:00:00+08:00",
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(ghlNames.status, 400);
  assertEquals((ghlNames.body as { code: string }).code, "invalid_window");
  assertEquals(calls.length, 0);
});

Deno.test("wired calendar_events handler is GET only, returns the window, and issues no write", async () => {
  const { calls, ghlGet } = getter([{
    events: [event("a"), event("b", { appointmentStatus: "cancelled" })],
  }]);
  const window = new URLSearchParams({
    userId: USER,
    start: "2026-09-14T00:00:00+08:00",
    end: "2026-09-21T00:00:00+08:00",
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const refused = await ghlCalendarEventsAction({
      method,
      params: window,
      locationId: LOCATION,
      ghlGet,
    });
    assertEquals(refused.status, 405);
    assertEquals(refused.body.ok, false);
    assertEquals((refused.body as { code: string }).code, "method_not_allowed");
  }
  assertEquals(calls.length, 0);

  const result = await ghlCalendarEventsAction({
    method: "GET",
    params: window,
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals((result.body.events as unknown[]).length, 2);
  const provenance = result.body.provenance as Record<string, unknown>;
  assertEquals(provenance.count, 2);
  assertEquals(provenance.failure, null);
  assertEquals(provenance.user_id, USER);
  assertEquals(provenance.calendar_id, null);
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0], "/calendars/events?");
  const query = windowQuery(calls[0]);
  assertEquals(query.get("locationId"), LOCATION);
  assertEquals(query.get("userId"), USER);
  assertEquals(query.get("startTime"), String(START));
  assertEquals(
    query.get("endTime"),
    String(Date.parse("2026-09-21T00:00:00+08:00")),
  );
  assertEquals(query.get("skip"), null);
  assertEquals(query.get("limit"), null);
  assertEquals([...query.keys()].sort(), [
    "endTime",
    "locationId",
    "startTime",
    "userId",
  ]);
});

Deno.test("window GET reads only body.events", async () => {
  const aliases = getter([{
    appointments: [event("via-appointments")],
    data: { events: [event("via-nested")] },
  }]);
  const ignored = await fetchGhlCalendarEvents({
    ghlGet: aliases.ghlGet,
    locationId: LOCATION,
    userId: USER,
    startMs: START,
    endMs: END,
  });
  assertEquals(ignored.events, []);
  assertEquals(ignored.count, 0);
  assertEquals(ignored.failure, null);

  const documented = getter([{ events: [event("via-events")] }]);
  const kept = await fetchGhlCalendarEvents({
    ghlGet: documented.ghlGet,
    locationId: LOCATION,
    userId: USER,
    startMs: START,
    endMs: END,
  });
  assertEquals(kept.count, 1);
  assertEquals((kept.events[0] as { id: string }).id, "via-events");
  assertEquals(kept.failure, null);
});

Deno.test("one unpaged window GET keeps a full GHL page", async () => {
  const many = Array.from({ length: 100 }, (_, i) => event(`e-${i}`));
  const { calls, ghlGet } = getter([{ events: many }]);
  const scan = await fetchGhlCalendarEvents({
    ghlGet,
    locationId: LOCATION,
    userId: USER,
    startMs: START,
    endMs: END,
  });
  assertEquals(scan.count, 100);
  assertEquals(scan.failure, null);
  assertEquals(scan.events.length, 100);
  assertEquals(calls.length, 1);
  const query = windowQuery(calls[0]);
  assertEquals(query.get("skip"), null);
  assertEquals(query.get("limit"), null);
});

Deno.test("a failed GHL window is named and not treated as complete", async () => {
  const { ghlGet } = getter([{ throw: "GHL 502: upstream" }]);
  const scan = await fetchGhlCalendarEvents({
    ghlGet,
    locationId: LOCATION,
    userId: USER,
    startMs: START,
    endMs: END,
  });
  assertEquals(scan.count, 0);
  assertEquals(scan.events, []);
  assertStringIncludes(scan.failure || "", "ghl_calendar_page_failed");
  assertStringIncludes(scan.failure || "", "GHL 502");
});

Deno.test("usersFromGhlBody reads only body.users", () => {
  assertEquals(
    usersFromGhlBody({
      data: [{ id: "via-data", email: "nithin@secureworkswa.com.au" }],
    }),
    [],
  );
  const users = usersFromGhlBody({
    users: [
      { id: "n1", email: "nithin@secureworkswa.com.au", name: "Nithin" },
      {
        id: "n2",
        email: "other@secureworkswa.com.au",
        firstName: "Other",
        lastName: "Person",
      },
    ],
    data: [{ id: "via-data", email: "marnin@secureworkswa.com.au" }],
  });
  assertEquals(users.map((user) => user.id), ["n1", "n2"]);
  assertEquals(users[0].name, "Nithin");
  assertEquals(users[0].firstName, null);
  assertEquals(users[1].name, null);
  assertEquals(users[1].firstName, "Other");
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

const WINDOW = {
  start: "2026-09-14T00:00:00+08:00",
  end: "2026-09-21T00:00:00+08:00",
};
const ROSTER = {
  users: [
    { id: USER, email: "nithin@secureworkswa.com.au", name: "Nithin" },
    {
      id: "ghl_user_marnin",
      email: "marnin@secureworkswa.com.au",
      name: "Marnin",
    },
    {
      id: "ghl_user_khairo",
      email: "khairo@secureworkswa.com.au",
      name: "Khairo",
    },
  ],
};

Deno.test("calendarId alone still reads the window", async () => {
  const { calls, ghlGet } = getter([{ events: [event("cal-1")] }]);
  const result = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      calendarId: "cal_nithin",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals((result.body.events as unknown[]).length, 1);
  const provenance = result.body.provenance as Record<string, unknown>;
  assertEquals(provenance.user_id, null);
  assertEquals(provenance.calendar_id, "cal_nithin");
  assertEquals(provenance.user_email, undefined);
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0], "/calendars/events?");
  const query = windowQuery(calls[0]);
  assertEquals(query.get("calendarId"), "cal_nithin");
  assertEquals(query.get("userId"), null);
});

Deno.test("user_email resolves one roster id and reads events for it", async () => {
  const { calls, ghlGet } = getter([
    ROSTER,
    { events: [event("n1"), event("n2")] },
  ]);
  const result = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "Nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals((result.body.events as unknown[]).length, 2);
  const provenance = result.body.provenance as Record<string, unknown>;
  assertEquals(provenance.user_email, "nithin@secureworkswa.com.au");
  assertEquals(provenance.user_id, USER);
  assertEquals(provenance.user_id_resolved_by, "roster_email_match");
  assertEquals(provenance.failure, null);
  assertEquals(calls.length, 2);
  assertStringIncludes(calls[0], "/users/?locationId=");
  assertStringIncludes(calls[1], "/calendars/events?");
  const query = windowQuery(calls[1]);
  assertEquals(query.get("userId"), USER);
  assertEquals(query.get("calendarId"), null);
});

Deno.test("user_email with zero or several roster matches refuses and does not read events", async () => {
  const zero = getter([{
    users: [
      { id: "ghl_user_marnin", email: "marnin@secureworkswa.com.au" },
    ],
  }]);
  const none = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet: zero.ghlGet,
  });
  assertEquals(none.status, 200);
  assertEquals(none.body.ok, false);
  assertEquals((none.body.events as unknown[]).length, 0);
  assertEquals(
    (none.body.provenance as { failure: string }).failure,
    "ghl_user_unmapped",
  );
  assertEquals(
    (none.body.provenance as { user_id: string | null }).user_id,
    null,
  );
  assertEquals(zero.calls.length, 1);
  assertStringIncludes(zero.calls[0], "/users/");

  const several = getter([{
    users: [
      { id: "n1", email: "nithin@secureworkswa.com.au" },
      { id: "n2", email: "nithin@secureworkswa.com.au" },
    ],
  }]);
  const many = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet: several.ghlGet,
  });
  assertEquals(many.status, 200);
  assertEquals(many.body.ok, false);
  assertEquals((many.body.events as unknown[]).length, 0);
  assertEquals(
    (many.body.provenance as { failure: string }).failure,
    "ghl_user_unmapped",
  );
  assertEquals(several.calls.length, 1);
  assertStringIncludes(several.calls[0], "/users/");
});

Deno.test("user_email with an unreadable roster refuses and does not read events", async () => {
  const { calls, ghlGet } = getter([{ throw: "GHL 502: upstream" }]);
  const result = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, false);
  assertEquals((result.body.events as unknown[]).length, 0);
  assertStringIncludes(
    (result.body.provenance as { failure: string }).failure,
    "ghl_users_unread",
  );
  assertEquals(
    (result.body.provenance as { user_email: string }).user_email,
    "nithin@secureworkswa.com.au",
  );
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0], "/users/");
});

Deno.test("two calendar_events selectors refuse and issue no GHL GET", async () => {
  const { calls, ghlGet } = getter([]);
  const pairs = [
    { userId: USER, calendarId: "cal_nithin", ...WINDOW },
    { userId: USER, user_email: "nithin@secureworkswa.com.au", ...WINDOW },
    {
      calendarId: "cal_nithin",
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    },
  ];
  for (const pair of pairs) {
    const refused = await ghlCalendarEventsAction({
      method: "GET",
      params: new URLSearchParams(pair),
      locationId: LOCATION,
      ghlGet,
    });
    assertEquals(refused.status, 400);
    assertEquals(refused.body.ok, false);
    assertEquals(
      (refused.body as { code: string }).code,
      "exactly_one_selector",
    );
  }
  assertEquals(calls.length, 0);
});

Deno.test("user_email calendar_events stays GET only", async () => {
  const { calls, ghlGet } = getter([]);
  const refused = await ghlCalendarEventsAction({
    method: "POST",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(refused.status, 405);
  assertEquals((refused.body as { code: string }).code, "method_not_allowed");
  assertEquals(calls.length, 0);
});
