/**
 * Outlook in the booking diary (D2, 23 Sep 2026).
 *
 * What these prove:
 *  - The owner's Outlook primary calendar is read beside GHL and every diary
 *    event names its source (`ghl` or `outlook`).
 *  - A failed Outlook read is a NAMED failure that marks the whole diary
 *    unread; it is never a free day, even though GHL read fine.
 *  - The mirror write is default off for callers that do not pass
 *    callerAuthorised (no Graph call at all, returns exactly what it would
 *    write) and idempotent on the GHL appointment id.
 *
 * What these do NOT prove: that Graph accepts the live request shapes. The
 * live read is in the PR description. A live executor press authorises the
 * write through SALES_BOOKING_BOOK_EXECUTE.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mergeSalesBookingDiaryEntries,
  projectSalesBookingDiaryEntry,
  projectSalesBookingOutlookDiaryEntry,
  readSalesBookingOutlookDiary,
  SALES_BOOKING_GHL_MIRROR_PROPERTY_ID,
  SALES_BOOKING_RESOURCES,
  type SalesBookingGraphGet,
  salesBookingRead,
  type SalesBookingReadDependencies,
} from "./sales_booking_read.ts";
import {
  buildOutlookMirrorRequest,
  type OutlookMirrorDependencies,
  type OutlookMirrorInput,
  outlookMirrorTransactionId,
  SALES_BOOKING_OUTLOOK_MIRROR_FLAG,
  writeOutlookMirrorEvent,
} from "./sales_booking_outlook_mirror.ts";

const NOW = new Date("2026-09-23T02:00:00.000Z");
const FRIDAY_WEEK = "2026-09-21";
const MARNIN = SALES_BOOKING_RESOURCES.marnin;
const NITHIN = SALES_BOOKING_RESOURCES.nithin;
const MAILBOX = "marnin@secureworkswa.com.au";

function graphEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "ol-1",
    subject: "Scope: Gareth Chapman, Alkimos",
    start: {
      dateTime: "2026-09-25T08:30:00.0000000",
      timeZone: "Australia/Perth",
    },
    end: {
      dateTime: "2026-09-25T09:30:00.0000000",
      timeZone: "Australia/Perth",
    },
    location: { displayName: "33 Providence Drive, Alkimos WA 6038" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    sensitivity: "normal",
    ...overrides,
  };
}

function ghlEntry(id: string, start: string, end: string, title: string) {
  return projectSalesBookingDiaryEntry({
    id,
    title,
    startTime: start,
    endTime: end,
    appointmentStatus: "confirmed",
  })!;
}

function graphGetFrom(
  pages: Array<{ status: number; body: unknown } | Error>,
): { get: SalesBookingGraphGet; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  return {
    urls,
    get: (url) => {
      urls.push(url);
      const page = pages[i++];
      if (!page) return Promise.reject(new Error("unexpected Graph GET"));
      if (page instanceof Error) return Promise.reject(page);
      return Promise.resolve(page);
    },
  };
}

function readDeps(
  overrides: Partial<SalesBookingReadDependencies> = {},
): SalesBookingReadDependencies {
  return {
    readOpportunities: () =>
      Promise.resolve({
        opportunities: [],
        stages: {},
        exhausted: true,
        pages_scanned: 1,
        total: 0,
        reason: null,
      }),
    readDiary: ({ scoperUserId }) =>
      Promise.resolve({
        read_ok: true,
        reason: null,
        entries: [
          ghlEntry(
            "ghl-1",
            "2026-09-25T10:00:00+08:00",
            "2026-09-25T11:00:00+08:00",
            "Scope: Melanie Nouchy, Scarborough",
          ),
        ],
        malformed_dropped: 0,
        calendar_email: MAILBOX,
        ghl_user_id: "ghl_user_marnin",
        mapped_by: "email",
        scoper_user_id: scoperUserId,
      }),
    readOutlookDiary: () =>
      Promise.resolve({
        state: "read",
        read_ok: true,
        reason: null,
        entries: [projectSalesBookingOutlookDiaryEntry(graphEvent())!],
        malformed_dropped: 0,
        calendar_email: MAILBOX,
      }),
    readThread: () => Promise.resolve([]),
    now: () => NOW,
    ...overrides,
  };
}

// ── Read + merge ────────────────────────────────────────────

Deno.test("merged diary carries both calendars on one timeline, each event labelled ghl or outlook", async () => {
  const payload = await salesBookingRead(readDeps(), {
    resource: "marnin",
    week_start: FRIDAY_WEEK,
    include_thread_facts: false,
  });
  assertEquals(payload.diary_read.read_ok, true);
  assertEquals(payload.diary_read.source, "ghl+outlook");
  assertEquals(
    payload.diary.map((row) => [row.source, row.event_id, row.start]),
    [
      ["outlook", "ol-1", "2026-09-25T08:30:00+08:00"],
      ["ghl", "ghl-1", "2026-09-25T10:00:00+08:00"],
    ],
  );
  for (const row of payload.diary) {
    assert(row.source === "ghl" || row.source === "outlook");
  }
  assertEquals(payload.diary_read.sources.ghl.event_count, 1);
  assertEquals(payload.diary_read.sources.outlook, {
    state: "read",
    read_ok: true,
    reason: null,
    calendar_email: MAILBOX,
    event_count: 1,
    malformed_dropped: 0,
  });
  assertEquals(payload.resource.calendar.ok, true);
  assert(
    payload.coverage.gaps.some((g) => g.includes("Outlook primary calendar")),
  );
});

Deno.test("a failed Outlook read is a named failure and the diary is unread, never a free day", async () => {
  const payload = await salesBookingRead(
    readDeps({
      readOutlookDiary: () =>
        Promise.resolve({
          state: "failed",
          read_ok: false,
          reason: "outlook_calendar_http_403",
          entries: [],
          malformed_dropped: 0,
          calendar_email: MAILBOX,
        }),
    }),
    {
      resource: "marnin",
      week_start: FRIDAY_WEEK,
      include_thread_facts: false,
    },
  );
  assertEquals(payload.diary_read.read_ok, false);
  assertEquals(
    payload.diary_read.reason,
    "outlook_calendar_unread: outlook_calendar_http_403",
  );
  assertEquals(payload.diary_read.sources.ghl.read_ok, true);
  assertEquals(payload.diary_read.sources.outlook.state, "failed");
  assertEquals(payload.coverage.diary_read_ok, false);
  assertEquals(payload.coverage.operational_leave, "not_read");
  // The Booking door paints "Calendar not connected" on this.
  assertEquals(payload.resource.calendar.ok, false);
  assertStringIncludes(
    payload.resource.calendar.error!,
    "outlook_calendar_http_403",
  );
  const gap = payload.coverage.gaps.find((g) =>
    g.startsWith("Outlook calendar unread")
  )!;
  assertStringIncludes(gap, "not free");
  // The GHL rows that WERE read still show; they are real.
  assertEquals(payload.diary.map((row) => row.source), ["ghl"]);
});

Deno.test("an Outlook reader that throws or is not wired is still a named failure", async () => {
  const threw = await salesBookingRead(
    readDeps({ readOutlookDiary: () => Promise.reject(new Error("boom")) }),
    {
      resource: "marnin",
      week_start: FRIDAY_WEEK,
      include_thread_facts: false,
    },
  );
  assertEquals(threw.diary_read.read_ok, false);
  assertEquals(
    threw.diary_read.sources.outlook.reason,
    "outlook_calendar_read_failed: boom",
  );

  const unwired = await salesBookingRead(
    readDeps({ readOutlookDiary: undefined }),
    {
      resource: "marnin",
      week_start: FRIDAY_WEEK,
      include_thread_facts: false,
    },
  );
  assertEquals(unwired.diary_read.read_ok, false);
  assertEquals(
    unwired.diary_read.sources.outlook.reason,
    "outlook_reader_not_wired",
  );
});

Deno.test("a resource with no Outlook mailbox reads GHL only and is not called", async () => {
  let called = false;
  const payload = await salesBookingRead(
    readDeps({
      readOutlookDiary: () => {
        called = true;
        return Promise.reject(new Error("must not be called"));
      },
    }),
    {
      resource: "nithin",
      week_start: FRIDAY_WEEK,
      include_thread_facts: false,
    },
  );
  assertEquals(called, false);
  assertEquals(payload.diary_read.read_ok, true);
  assertEquals(payload.diary_read.source, "ghl");
  assertEquals(payload.diary_read.sources.outlook.state, "not_configured");
  assertEquals(NITHIN.lane, "patio");
});

Deno.test("Outlook reader pages calendarView, keeps kinds from provider fields and labels mirrors", async () => {
  const graph = graphGetFrom([
    {
      status: 200,
      body: {
        value: [
          graphEvent(),
          graphEvent({
            id: "ol-private",
            subject: "Dentist",
            sensitivity: "private",
            location: { displayName: "Home" },
          }),
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
      },
    },
    {
      status: 200,
      body: {
        value: [
          graphEvent({ id: "ol-leave", subject: "Away", showAs: "oof" }),
          graphEvent({ id: "ol-free", showAs: "free" }),
          graphEvent({ id: "ol-cancelled", isCancelled: true }),
          graphEvent({
            id: "ol-mirror",
            singleValueExtendedProperties: [
              { id: SALES_BOOKING_GHL_MIRROR_PROPERTY_ID, value: "ghl-appt-9" },
            ],
          }),
          { id: "ol-bad" },
        ],
      },
    },
  ]);
  const scan = await readSalesBookingOutlookDiary({
    graphGet: graph.get,
    resourceId: "marnin",
    scoperUserId: MARNIN.scoper_user_id,
    since: "2026-09-21T00:00:00+08:00",
    untilExclusive: "2026-09-28T00:00:00+08:00",
  });
  assertEquals(scan.state, "read");
  assertEquals(scan.read_ok, true);
  assertEquals(scan.calendar_email, MAILBOX);
  assertEquals(scan.malformed_dropped, 1);
  assertEquals(graph.urls.length, 2);
  const first = new URL(graph.urls[0]);
  assertEquals(
    first.pathname,
    "/v1.0/users/marnin%40secureworkswa.com.au/calendarView",
  );
  assertEquals(
    first.searchParams.get("startDateTime"),
    "2026-09-20T16:00:00.000Z",
  );
  assertEquals(
    first.searchParams.get("endDateTime"),
    "2026-09-27T16:00:00.000Z",
  );
  const byId = Object.fromEntries(
    scan.entries.map((row) => [row.event_id, row]),
  );
  assertEquals(byId["ol-1"].source, "outlook");
  assertEquals(byId["ol-1"].start, "2026-09-25T08:30:00+08:00");
  assertEquals(byId["ol-1"].title, "Scope: Gareth Chapman, Alkimos");
  assertEquals(byId["ol-1"].blocks_capacity, true);
  assertEquals(byId["ol-private"].kind, "personal");
  assertEquals(byId["ol-private"].title, null);
  assertEquals(byId["ol-private"].location, null);
  assertEquals(byId["ol-private"].title_withheld, true);
  assertEquals(byId["ol-private"].blocks_capacity, true);
  assertEquals(byId["ol-leave"].kind, "leave");
  assertEquals(byId["ol-free"].blocks_capacity, false);
  assertEquals(byId["ol-cancelled"].blocks_capacity, false);
  assertEquals(byId["ol-cancelled"].show_as, "cancelled");
  assertEquals(byId["ol-mirror"].mirror_of_ghl_event_id, "ghl-appt-9");
  assertEquals(byId["ol-1"].mirror_of_ghl_event_id, null);
});

Deno.test("Outlook reader failures are named and carry no entries", async () => {
  const base = {
    resourceId: "marnin",
    scoperUserId: MARNIN.scoper_user_id,
    since: "2026-09-21T00:00:00+08:00",
    untilExclusive: "2026-09-28T00:00:00+08:00",
  };
  const cases: Array<
    [Array<{ status: number; body: unknown } | Error>, string]
  > = [
    [[{ status: 403, body: null }], "outlook_calendar_http_403"],
    [
      [{ status: 200, body: { nope: true } }],
      "outlook_calendar_page_malformed",
    ],
    [[new Error("timeout")], "outlook_calendar_read_failed: timeout"],
    [
      [
        {
          status: 200,
          body: {
            value: [graphEvent()],
            "@odata.nextLink": "https://evil.example/next",
          },
        },
      ],
      "outlook_calendar_next_link_invalid",
    ],
    [
      // A second page after a good first page fails: the partial week is dropped.
      [
        {
          status: 200,
          body: {
            value: [graphEvent()],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/p2",
          },
        },
        { status: 502, body: null },
      ],
      "outlook_calendar_http_502",
    ],
  ];
  for (const [pages, reason] of cases) {
    const scan = await readSalesBookingOutlookDiary({
      ...base,
      graphGet: graphGetFrom(pages).get,
    });
    assertEquals(scan.state, "failed");
    assertEquals(scan.read_ok, false);
    assertEquals(scan.reason, reason);
    assertEquals(scan.entries, []);
  }
});

Deno.test("merge orders by start, then source, then id", () => {
  const ghl = [
    ghlEntry(
      "g-b",
      "2026-09-25T10:00:00+08:00",
      "2026-09-25T11:00:00+08:00",
      "b",
    ),
  ];
  const outlook = [
    projectSalesBookingOutlookDiaryEntry(
      graphEvent({
        id: "o-a",
        start: { dateTime: "2026-09-25T10:00:00" },
        end: { dateTime: "2026-09-25T11:00:00" },
      }),
    )!,
  ];
  assertEquals(
    mergeSalesBookingDiaryEntries(ghl, outlook).map((row) => row.event_id),
    ["g-b", "o-a"],
  );
});

// ── Mirror write ────────────────────────────────────────────

const MIRROR_INPUT: OutlookMirrorInput = {
  resource_id: "marnin",
  ghl_appointment_id: "ghlAppt_123",
  client_name: "Jane Citizen",
  suburb: "Joondalup",
  start: "2026-09-25T10:00:00+08:00",
  end: "2026-09-25T11:00:00+08:00",
  address: "1 Example Street, Joondalup WA 6027",
};

/** In-memory Outlook calendar keyed on the mirror property. */
function fakeOutlook(env: Record<string, string> = {}) {
  const events: Array<{ id: string; ghl: string; body: unknown }> = [];
  const calls: Array<{ method: string; url: string }> = [];
  const deps: OutlookMirrorDependencies = {
    env: (name) => env[name],
    graphGet: (url) => {
      calls.push({ method: "GET", url });
      const filter = new URL(url).searchParams.get("$filter") || "";
      const value = /ep\/value eq '([^']+)'/.exec(filter)?.[1];
      return Promise.resolve({
        status: 200,
        body: {
          value: events.filter((e) => e.ghl === value).map((e) => ({
            id: e.id,
          })),
        },
      });
    },
    graphPost: (url, body) => {
      calls.push({ method: "POST", url });
      const props =
        (body as { singleValueExtendedProperties: Array<{ value: string }> })
          .singleValueExtendedProperties;
      const id = `ol-${events.length + 1}`;
      events.push({ id, ghl: props[0].value, body });
      return Promise.resolve({ status: 201, body: { id } });
    },
  };
  return { deps, events, calls };
}

Deno.test("callerAuthorised writes even when the module switch is off", async () => {
  const outlook = fakeOutlook({});
  const result = await writeOutlookMirrorEvent(MIRROR_INPUT, outlook.deps, {
    callerAuthorised: true,
  });
  assertEquals(result.code, "mirrored");
  assertEquals(result.wrote, true);
  assertEquals(outlook.calls.map((c) => c.method), ["GET", "POST"]);
});

Deno.test("mirror switch off writes nothing, calls Graph not at all, and returns exactly what it would write", async () => {
  for (
    const env of [
      {},
      { [SALES_BOOKING_OUTLOOK_MIRROR_FLAG]: "1" },
      { [SALES_BOOKING_OUTLOOK_MIRROR_FLAG]: "TRUE" },
    ] as Record<string, string>[]
  ) {
    const outlook = fakeOutlook(env);
    const result = await writeOutlookMirrorEvent(MIRROR_INPUT, outlook.deps);
    assertEquals(outlook.calls, []);
    assertEquals(outlook.events, []);
    assertEquals(result.code, "flag_off");
    assertEquals(result.wrote, false);
    const built = buildOutlookMirrorRequest(MIRROR_INPUT);
    assert(built.ok);
    if (result.code === "flag_off") {
      assertEquals(result.would_write, built.request);
    }
  }
});

Deno.test("mirror request uses the owner's title shape, the GHL appointment span and no attendees", () => {
  const built = buildOutlookMirrorRequest(MIRROR_INPUT);
  assert(built.ok);
  if (!built.ok) return;
  assertEquals(built.request.method, "POST");
  assertEquals(
    built.request.path,
    "/users/marnin%40secureworkswa.com.au/calendar/events",
  );
  const body = built.request.body as Record<string, unknown>;
  assertEquals(body.subject, "Scope: Jane Citizen, Joondalup");
  assertEquals(body.start, {
    dateTime: "2026-09-25T10:00:00",
    timeZone: "Australia/Perth",
  });
  assertEquals(body.end, {
    dateTime: "2026-09-25T11:00:00",
    timeZone: "Australia/Perth",
  });
  assertEquals(body.attendees, []);
  assertEquals(body.responseRequested, false);
  assertEquals(body.showAs, "busy");
  assertEquals(body.location, {
    displayName: "1 Example Street, Joondalup WA 6027",
  });
  assertEquals(body.transactionId, outlookMirrorTransactionId("ghlAppt_123"));
  assertEquals(body.singleValueExtendedProperties, [
    { id: SALES_BOOKING_GHL_MIRROR_PROPERTY_ID, value: "ghlAppt_123" },
  ]);
  assertStringIncludes(
    (body.body as { content: string }).content,
    "Booked in GHL 10:00 to 11:00, appointment ghlAppt_123.",
  );
  const utc = buildOutlookMirrorRequest({
    ...MIRROR_INPUT,
    start: "2026-09-25T02:00:00Z",
    end: "2026-09-25T03:00:00Z",
  });
  assert(utc.ok);
  if (utc.ok) {
    assertEquals(
      (utc.request.body.start as { dateTime: string }).dateTime,
      "2026-09-25T10:00:00",
    );
  }
});

Deno.test("mirror write is idempotent on the GHL appointment id", async () => {
  const outlook = fakeOutlook({ [SALES_BOOKING_OUTLOOK_MIRROR_FLAG]: "true" });
  const first = await writeOutlookMirrorEvent(MIRROR_INPUT, outlook.deps);
  assertEquals(first.code, "mirrored");
  assertEquals(first.wrote, true);
  const second = await writeOutlookMirrorEvent(MIRROR_INPUT, outlook.deps);
  assertEquals(second.code, "already_mirrored");
  assertEquals(second.wrote, false);
  if (second.code === "already_mirrored" && first.code === "mirrored") {
    assertEquals(second.outlook_event_id, first.outlook_event_id);
  }
  assertEquals(outlook.events.length, 1);
  assertEquals(outlook.calls.map((c) => c.method), ["GET", "POST", "GET"]);
  // A different appointment is its own event.
  const other = await writeOutlookMirrorEvent(
    { ...MIRROR_INPUT, ghl_appointment_id: "ghlAppt_456" },
    outlook.deps,
  );
  assertEquals(other.code, "mirrored");
  assertEquals(outlook.events.length, 2);
});

Deno.test("mirror never writes blind when the idempotency lookup fails", async () => {
  const outlook = fakeOutlook({ [SALES_BOOKING_OUTLOOK_MIRROR_FLAG]: "true" });
  const failing: OutlookMirrorDependencies = {
    ...outlook.deps,
    graphGet: () => Promise.resolve({ status: 403, body: null }),
  };
  const result = await writeOutlookMirrorEvent(MIRROR_INPUT, failing);
  assertEquals(result.code, "mirror_lookup_failed");
  assertEquals(result.wrote, false);
  assertEquals(outlook.events, []);

  const thrown = await writeOutlookMirrorEvent(MIRROR_INPUT, {
    ...outlook.deps,
    graphGet: () => Promise.reject(new Error("network")),
  });
  assertEquals(thrown.code, "mirror_lookup_failed");
  assertEquals(outlook.events, []);
});

Deno.test("mirror separates a refused create from an uncertain one", async () => {
  const outlook = fakeOutlook({ [SALES_BOOKING_OUTLOOK_MIRROR_FLAG]: "true" });
  const refused = await writeOutlookMirrorEvent(MIRROR_INPUT, {
    ...outlook.deps,
    graphPost: () => Promise.resolve({ status: 400, body: { error: {} } }),
  });
  assertEquals(refused.code, "mirror_write_failed");
  const unknown = await writeOutlookMirrorEvent(MIRROR_INPUT, {
    ...outlook.deps,
    graphPost: () => Promise.reject(new Error("socket hang up")),
  });
  assertEquals(unknown.code, "mirror_outcome_unknown");
  const throttled = await writeOutlookMirrorEvent(MIRROR_INPUT, {
    ...outlook.deps,
    graphPost: () => Promise.resolve({ status: 503, body: null }),
  });
  assertEquals(throttled.code, "mirror_outcome_unknown");
});

Deno.test("mirror refuses bad input before any Graph call, whatever the switch", async () => {
  const outlook = fakeOutlook({ [SALES_BOOKING_OUTLOOK_MIRROR_FLAG]: "true" });
  const bad: Array<Partial<OutlookMirrorInput>> = [
    { resource_id: "nithin" },
    { resource_id: "someone" },
    { ghl_appointment_id: "x' or 1 eq 1" },
    { client_name: "  " },
    { suburb: "" },
    { start: "2026-09-25T10:00:00" },
    { end: "2026-09-25T09:00:00+08:00" },
    { address: "line\nbreak" },
  ];
  for (const patch of bad) {
    const result = await writeOutlookMirrorEvent(
      { ...MIRROR_INPUT, ...patch },
      outlook.deps,
    );
    assertEquals(result.code, "invalid_input", JSON.stringify(patch));
  }
  assertEquals(outlook.calls, []);
});
