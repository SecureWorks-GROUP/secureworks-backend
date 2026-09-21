/**
 * ghl-proxy calendar_directory and calendar_person_events — read-only.
 *
 * What these prove: GET only, per-read receipts so a failed provider GET is
 * never an empty list, assignments come from teamMembers or are marked
 * absent, person events merge assigned calendars plus userId and de-dupe by
 * event id, a failed calendar among several marks complete false. No writes.
 *
 * Fixture coverage only. These three live GHL reads stay unproven until a
 * post-deploy read: (a) a scoper email resolves a live GHL user id by unique
 * roster email match and returns that person's diary, (b) calendar_directory
 * lists existing GHL calendars plus the full roster as id, name, and email
 * only, without writing, (c) calendar_person_events for one scoper does not
 * include another person's appointments from a shared calendar.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calendarsFromGhlBody,
  ghlCalendarDirectoryAction,
  ghlCalendarPersonEventsAction,
} from "./calendar_events.ts";

const LOCATION = "loc_secureworks";
const USER = "ghl_user_nithin";
const CAL_A = "cal_nithin_patios";
const CAL_B = "cal_shared";
const WINDOW = {
  start: "2026-09-14T00:00:00+08:00",
  end: "2026-09-21T00:00:00+08:00",
};

function getter(
  replies: Array<Record<string, unknown> | { throw: string }>,
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

function event(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Event ${id}`,
    appointmentStatus: "confirmed",
    assignedUserId: USER,
    ...extra,
  };
}

const ROSTER = {
  users: [
    { id: USER, email: "nithin@secureworkswa.com.au", name: "Nithin" },
    {
      id: "ghl_user_marnin",
      email: "marnin@secureworkswa.com.au",
      name: "Marnin",
    },
    {
      id: "ghl_user_other",
      email: "other@secureworkswa.com.au",
      name: "Other",
    },
  ],
};

const CALENDARS_WITH_ASSIGNMENTS = {
  calendars: [
    {
      id: CAL_A,
      name: "Nithin patios",
      isActive: true,
      teamMembers: [{ userId: USER, selected: true, priority: 1 }],
      slug: "must-not-leak",
      description: "must-not-leak",
    },
    {
      id: CAL_B,
      name: "Shared",
      isActive: false,
      teamMembers: [
        { userId: USER },
        { userId: "ghl_user_marnin" },
      ],
    },
    {
      id: "cal_marnin_only",
      name: "Marnin Stratco",
      isActive: true,
      teamMembers: [{ userId: "ghl_user_marnin" }],
    },
  ],
};

Deno.test("calendarsFromGhlBody reads only body.calendars and drops extra fields", () => {
  assertEquals(
    calendarsFromGhlBody({ calendars: [] }),
    { calendars: [], failure: null },
  );
  assertEquals(
    calendarsFromGhlBody({
      data: [{ id: "via-data", name: "nope" }],
    }),
    { calendars: [], failure: "ghl_calendars_malformed" },
  );
  assertEquals(
    calendarsFromGhlBody({ calendars: "nope" }),
    { calendars: [], failure: "ghl_calendars_malformed" },
  );
  const parsed = calendarsFromGhlBody(CALENDARS_WITH_ASSIGNMENTS);
  assertEquals(parsed.failure, null);
  const rows = parsed.calendars;
  assertEquals(rows.map((row) => row.id), [CAL_A, CAL_B, "cal_marnin_only"]);
  assertEquals(rows[0], {
    id: CAL_A,
    name: "Nithin patios",
    is_active: true,
    assigned_user_ids: [USER],
    assignments_returned: true,
  });
  assertEquals(rows[1].is_active, false);
  assertEquals(rows[1].assigned_user_ids, [USER, "ghl_user_marnin"]);
  assertEquals(
    Object.keys(rows[0]).sort(),
    [
      "assigned_user_ids",
      "assignments_returned",
      "id",
      "is_active",
      "name",
    ],
  );
});

Deno.test("calendarsFromGhlBody does not invent assignments when teamMembers is absent", () => {
  const parsed = calendarsFromGhlBody({
    calendars: [{ id: "cal_plain", name: "Plain", isActive: true }],
  });
  assertEquals(parsed.failure, null);
  const rows = parsed.calendars;
  assertEquals(rows[0].assignments_returned, false);
  assertEquals(rows[0].assigned_user_ids, []);
  assertEquals(rows[0].is_active, true);
});

Deno.test("calendar_directory keeps documented empty arrays as a valid empty listing", async () => {
  const { ghlGet } = getter([{ calendars: [] }, { users: [] }]);
  const result = await ghlCalendarDirectoryAction({
    method: "GET",
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(result.body.calendars, []);
  assertEquals(result.body.users, []);
  const provenance = result.body.provenance as {
    calendars: { ok: boolean; count: number; failure: null };
    users: { ok: boolean; count: number; failure: null };
  };
  assertEquals(provenance.calendars, { ok: true, count: 0, failure: null });
  assertEquals(provenance.users, { ok: true, count: 0, failure: null });
});

Deno.test("calendar_directory is GET only and returns two receipts", async () => {
  const { calls, ghlGet } = getter([]);
  const post = await ghlCalendarDirectoryAction({
    method: "POST",
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(post.status, 405);
  assertEquals((post.body as { code: string }).code, "method_not_allowed");
  assertEquals(calls.length, 0);

  const listed = getter([CALENDARS_WITH_ASSIGNMENTS, ROSTER]);
  const result = await ghlCalendarDirectoryAction({
    method: "GET",
    locationId: LOCATION,
    ghlGet: listed.ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals((result.body.calendars as unknown[]).length, 3);
  const users = result.body.users as Array<Record<string, unknown>>;
  assertEquals(users.map((user) => user.id), [
    USER,
    "ghl_user_marnin",
    "ghl_user_other",
  ]);
  assertEquals(Object.keys(users[0]).sort(), ["email", "id", "name"]);
  const provenance = result.body.provenance as {
    calendars: { ok: boolean; count: number; failure: null };
    users: { ok: boolean; count: number; failure: null };
  };
  assertEquals(provenance.calendars, { ok: true, count: 3, failure: null });
  assertEquals(provenance.users, { ok: true, count: 3, failure: null });
  assertEquals(listed.calls.length, 2);
  assertStringIncludes(listed.calls[0], "/calendars/?locationId=");
  assertStringIncludes(listed.calls[1], "/users/?locationId=");
});

Deno.test("calendar_directory keeps the other half when one provider read fails", async () => {
  const calendarsFail = getter([
    { throw: "GHL 502: calendars" },
    ROSTER,
  ]);
  const noCalendars = await ghlCalendarDirectoryAction({
    method: "GET",
    locationId: LOCATION,
    ghlGet: calendarsFail.ghlGet,
  });
  assertEquals(noCalendars.body.ok, false);
  assertEquals(noCalendars.body.calendars, []);
  assertEquals((noCalendars.body.users as unknown[]).length, 3);
  const calProv = noCalendars.body.provenance as {
    calendars: { ok: boolean; failure: string };
    users: { ok: boolean };
  };
  assertEquals(calProv.calendars.ok, false);
  assertStringIncludes(calProv.calendars.failure, "ghl_calendars_unread");
  assertEquals(calProv.users.ok, true);

  const usersFail = getter([
    CALENDARS_WITH_ASSIGNMENTS,
    { throw: "GHL 401: users" },
  ]);
  const noUsers = await ghlCalendarDirectoryAction({
    method: "GET",
    locationId: LOCATION,
    ghlGet: usersFail.ghlGet,
  });
  assertEquals(noUsers.body.ok, false);
  assertEquals((noUsers.body.calendars as unknown[]).length, 3);
  assertEquals(noUsers.body.users, []);
  const userProv = noUsers.body.provenance as {
    calendars: { ok: boolean };
    users: { ok: boolean; failure: string };
  };
  assertEquals(userProv.calendars.ok, true);
  assertEquals(userProv.users.ok, false);
  assertStringIncludes(userProv.users.failure, "ghl_users_unread");
});

Deno.test("calendar_person_events is GET only and requires user_email plus a window", async () => {
  const { calls, ghlGet } = getter([]);
  const post = await ghlCalendarPersonEventsAction({
    method: "POST",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(post.status, 405);
  assertEquals(calls.length, 0);

  const missing = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams(WINDOW),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(missing.status, 400);
  assertEquals(
    (missing.body as { code: string }).code,
    "user_email_required",
  );
});

Deno.test("calendar_person_events merges assigned calendars with the userId window and de-dupes", async () => {
  const { calls, ghlGet } = getter([
    ROSTER,
    CALENDARS_WITH_ASSIGNMENTS,
    { events: [event("shared"), event("user-only")] },
    { events: [event("shared"), event("cal-a")] },
    { events: [event("cal-b")] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(result.body.complete, true);
  const events = result.body.events as Array<{ id: string }>;
  assertEquals(events.map((row) => row.id), [
    "shared",
    "user-only",
    "cal-a",
    "cal-b",
  ]);
  const provenance = result.body.provenance as Record<string, unknown>;
  assertEquals(provenance.user_email, "nithin@secureworkswa.com.au");
  assertEquals(provenance.user_id, USER);
  assertEquals(provenance.user_id_resolved_by, "roster_email_match");
  assertEquals(provenance.dedicated_calendar, "unconfirmed");
  assertEquals(provenance.dedicated_calendar_id, null);
  assertEquals(provenance.calendar_purpose, "patios");
  assertEquals(provenance.deduplicated, 1);
  assertEquals(provenance.assignments_returned, true);
  assertEquals(provenance.complete, true);
  const calendarReads = provenance.calendar_reads as Array<
    { calendar_id: string; ok: boolean; count: number }
  >;
  assertEquals(calendarReads.map((row) => row.calendar_id), [CAL_A, CAL_B]);
  assertEquals(calls.length, 5);
  assertStringIncludes(calls[0], "/users/");
  assertStringIncludes(calls[1], "/calendars/?locationId=");
  assertStringIncludes(calls[2], "userId=");
  assertStringIncludes(calls[3], `calendarId=${CAL_A}`);
  assertStringIncludes(calls[3], `userId=${USER}`);
  assertStringIncludes(calls[4], `calendarId=${CAL_B}`);
  assertStringIncludes(calls[4], `userId=${USER}`);
  assertEquals(calls.some((path) => path.includes("cal_marnin_only")), false);
});

Deno.test("a failed calendar read among several marks complete false and keeps the others", async () => {
  const { calls, ghlGet } = getter([
    ROSTER,
    CALENDARS_WITH_ASSIGNMENTS,
    { events: [event("user-only")] },
    { throw: "GHL 502: calendar A" },
    { events: [event("cal-b")] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
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
  assertEquals(result.body.complete, false);
  const events = result.body.events as Array<{ id: string }>;
  assertEquals(events.map((row) => row.id), ["user-only", "cal-b"]);
  const reads = (result.body.provenance as {
    calendar_reads: Array<
      { calendar_id: string; ok: boolean; failure: string | null }
    >;
  }).calendar_reads;
  assertEquals(reads[0].calendar_id, CAL_A);
  assertEquals(reads[0].ok, false);
  assertStringIncludes(reads[0].failure || "", "ghl_calendar_page_failed");
  assertEquals(reads[1].calendar_id, CAL_B);
  assertEquals(reads[1].ok, true);
  assertEquals(calls.length, 5);
});

Deno.test("calendar_person_events refuses zero or several roster matches without reading events", async () => {
  const zero = getter([{
    users: [{ id: "ghl_user_marnin", email: "marnin@secureworkswa.com.au" }],
  }]);
  const none = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet: zero.ghlGet,
  });
  assertEquals(none.body.ok, false);
  assertEquals(none.body.complete, false);
  assertEquals(none.body.events, []);
  assertEquals(
    (none.body.provenance as { failure: string }).failure,
    "ghl_user_unmapped",
  );
  assertEquals(zero.calls.length, 1);
  assertStringIncludes(zero.calls[0], "/users/");

  const several = getter([{
    users: [
      { id: "n1", email: "nithin@secureworkswa.com.au" },
      { id: "n2", email: "nithin@secureworkswa.com.au" },
    ],
  }]);
  const many = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet: several.ghlGet,
  });
  assertEquals(many.body.ok, false);
  assertEquals(many.body.events, []);
  assertEquals(several.calls.length, 1);
});

Deno.test("calendar_person_events refuses a non-scoper roster address before reading the roster", async () => {
  const { calls, ghlGet } = getter([ROSTER]);
  const result = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "other@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.ok, false);
  assertEquals(
    (result.body as { code: string }).code,
    "scoper_email_required",
  );
  assertEquals(calls.length, 0);
});

Deno.test("calendar_person_events keeps another assignee's shared-calendar appointments out", async () => {
  const calls: string[] = [];
  const nithinShared = event("nithin-shared");
  const marninStratco = event("marnin-stratco", {
    assignedUserId: "ghl_user_marnin",
  });
  const ghlGet = (path: string) => {
    calls.push(path);
    if (path.includes("/users/")) return Promise.resolve(ROSTER);
    if (path.startsWith("/calendars/?") || path.includes("/calendars/?locationId=")) {
      return Promise.resolve(CALENDARS_WITH_ASSIGNMENTS);
    }
    if (path.includes("/calendars/events")) {
      const query = new URL(path, "https://ghl.example").searchParams;
      const userId = query.get("userId");
      const calendarId = query.get("calendarId");
      if (userId === USER && !calendarId) {
        return Promise.resolve({ events: [event("user-only")] });
      }
      if (calendarId === CAL_A) {
        return Promise.resolve({ events: [event("cal-a")] });
      }
      if (calendarId === CAL_B) {
        const shared = [nithinShared, marninStratco];
        if (userId === USER) {
          return Promise.resolve({
            events: shared.filter((row) => row.assignedUserId === USER),
          });
        }
        return Promise.resolve({ events: shared });
      }
    }
    return Promise.reject(new Error(`unexpected GHL GET ${path}`));
  };
  const result = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  const ids = (result.body.events as Array<{ id: string }>).map((row) =>
    row.id
  );
  assertEquals(ids.includes("marnin-stratco"), false);
  assertEquals(ids.includes("nithin-shared"), true);
  const sharedCall = calls.find((path) => path.includes(`calendarId=${CAL_B}`));
  assertStringIncludes(sharedCall || "", `userId=${USER}`);
  assertEquals(
    (result.body.provenance as { dedicated_calendar_id: string | null })
      .dedicated_calendar_id,
    null,
  );
});

Deno.test("calendar_person_events without teamMembers does not infer assignments", async () => {
  const { calls, ghlGet } = getter([
    ROSTER,
    { calendars: [{ id: CAL_A, name: "Nithin patios", isActive: true }] },
    { events: [event("user-only")] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.body.ok, false);
  assertEquals(result.body.complete, false);
  assertEquals(
    (result.body.provenance as { assignments_returned: boolean })
      .assignments_returned,
    false,
  );
  assertEquals(
    (result.body.provenance as { calendar_reads: unknown[] }).calendar_reads
      .length,
    0,
  );
  assertEquals(
    (result.body.events as Array<{ id: string }>).map((row) => row.id),
    ["user-only"],
  );
  assertEquals(calls.length, 3);
  assertEquals(calls.some((path) => path.includes("calendarId=")), false);
});

Deno.test("a documented empty calendars array stays a complete empty assigned set", async () => {
  const { ghlGet } = getter([
    ROSTER,
    { calendars: [] },
    { events: [] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  assertEquals(result.body.complete, true);
  assertEquals(result.body.events, []);
  const provenance = result.body.provenance as {
    assignments_returned: boolean;
    calendars_list: { ok: boolean; count: number; failure: string | null };
  };
  assertEquals(provenance.assignments_returned, true);
  assertEquals(provenance.calendars_list, { ok: true, count: 0, failure: null });
});

Deno.test("calendar_person_events treats a missing calendars field as unread, not an empty complete diary", async () => {
  const { calls, ghlGet } = getter([
    ROSTER,
    { unexpected: "provider response omitted calendars" },
    { events: [] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
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
  assertEquals(result.body.complete, false);
  assertEquals(result.body.events, []);
  const provenance = result.body.provenance as {
    assignments_returned: boolean;
    complete: boolean;
    calendars_list: { ok: boolean; count: number; failure: string | null };
  };
  assertEquals(provenance.complete, false);
  assertEquals(provenance.assignments_returned, false);
  assertEquals(provenance.calendars_list.ok, false);
  assertEquals(provenance.calendars_list.count, 0);
  assertEquals(provenance.calendars_list.failure, "ghl_calendars_malformed");
  assertEquals(calls.some((path) => path.includes("calendarId=")), false);
});

Deno.test("calendar_directory treats a missing calendars field as unread, not an empty list", async () => {
  const { ghlGet } = getter([
    { unexpected: "provider response omitted calendars" },
    ROSTER,
  ]);
  const result = await ghlCalendarDirectoryAction({
    method: "GET",
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, false);
  assertEquals(result.body.calendars, []);
  assertEquals((result.body.users as unknown[]).length, 3);
  const provenance = result.body.provenance as {
    calendars: { ok: boolean; count: number; failure: string | null };
    users: { ok: boolean; count: number };
  };
  assertEquals(provenance.calendars.ok, false);
  assertEquals(provenance.calendars.count, 0);
  assertEquals(provenance.calendars.failure, "ghl_calendars_malformed");
  assertEquals(provenance.users.ok, true);
});

Deno.test("calendar_directory treats a missing users field as unread, not an empty roster", async () => {
  const { ghlGet } = getter([
    CALENDARS_WITH_ASSIGNMENTS,
    { unexpected: "provider response omitted users" },
  ]);
  const result = await ghlCalendarDirectoryAction({
    method: "GET",
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, false);
  assertEquals((result.body.calendars as unknown[]).length, 3);
  assertEquals(result.body.users, []);
  const provenance = result.body.provenance as {
    calendars: { ok: boolean };
    users: { ok: boolean; count: number; failure: string | null };
  };
  assertEquals(provenance.calendars.ok, true);
  assertEquals(provenance.users.ok, false);
  assertEquals(provenance.users.count, 0);
  assertEquals(provenance.users.failure, "ghl_users_malformed");
});

Deno.test("calendar_person_events treats a missing users field as unread, not an unmapped scoper", async () => {
  const { calls, ghlGet } = getter([
    { unexpected: "provider response omitted users" },
  ]);
  const result = await ghlCalendarPersonEventsAction({
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
  assertEquals(result.body.complete, false);
  assertEquals(result.body.events, []);
  assertEquals(
    (result.body.provenance as { failure: string }).failure,
    "ghl_users_malformed",
  );
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0], "/users/");
});

Deno.test("calendar_person_events treats a malformed assignment row as incomplete", async () => {
  const { calls, ghlGet } = getter([
    ROSTER,
    {
      calendars: [
        {
          id: CAL_A,
          name: "Nithin patios",
          isActive: true,
          teamMembers: [{ userId: USER }, { selected: true }, "bad"],
        },
      ],
    },
    { events: [event("user-only")] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
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
  assertEquals(result.body.complete, false);
  assertEquals(
    (result.body.provenance as { assignments_returned: boolean })
      .assignments_returned,
    false,
  );
  assertEquals(
    (result.body.provenance as { calendar_reads: unknown[] }).calendar_reads
      .length,
    0,
  );
  assertEquals(
    (result.body.events as Array<{ id: string }>).map((row) => row.id),
    ["user-only"],
  );
  assertEquals(calls.some((path) => path.includes("calendarId=")), false);
});

Deno.test("calendar_person_events treats an invalid calendar id row as unread, not complete", async () => {
  const { calls, ghlGet } = getter([
    ROSTER,
    {
      calendars: [
        {
          id: CAL_A,
          name: "Nithin patios",
          teamMembers: [{ userId: USER }],
        },
        {
          name: "no-id",
          teamMembers: [{ userId: USER }],
        },
      ],
    },
    { events: [event("user-only")] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
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
  assertEquals(result.body.complete, false);
  const provenance = result.body.provenance as {
    assignments_returned: boolean;
    calendars_list: { ok: boolean; failure: string | null };
  };
  assertEquals(provenance.assignments_returned, false);
  assertEquals(provenance.calendars_list.ok, false);
  assertEquals(provenance.calendars_list.failure, "ghl_calendars_malformed");
  assertEquals(
    (result.body.events as Array<{ id: string }>).map((row) => row.id),
    ["user-only"],
  );
  assertEquals(calls.some((path) => path.includes("calendarId=")), false);
});

Deno.test("a shared calendar appointment for another rep is not this rep's busy time", async () => {
  const marninStratco = event("marnin-stratco", {
    assignedUserId: "ghl_user_marnin",
  });
  const nithinShared = event("nithin-shared");
  const { calls, ghlGet } = getter([
    ROSTER,
    CALENDARS_WITH_ASSIGNMENTS,
    { events: [event("user-only")] },
    { events: [event("cal-a")] },
    { events: [nithinShared, marninStratco] },
  ]);
  const result = await ghlCalendarPersonEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "nithin@secureworkswa.com.au",
      ...WINDOW,
    }),
    locationId: LOCATION,
    ghlGet,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, true);
  const ids = (result.body.events as Array<{ id: string }>).map((row) =>
    row.id
  );
  assertEquals(ids.includes("marnin-stratco"), false);
  assertEquals(ids.includes("nithin-shared"), true);
  assertEquals(ids.includes("user-only"), true);
  const sharedCall = calls.find((path) => path.includes(`calendarId=${CAL_B}`));
  assertStringIncludes(sharedCall || "", `userId=${USER}`);
});
