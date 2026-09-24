// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applySalesBookingAvailability,
  type AvailabilityInput,
  computeSalesBookingAvailability,
  type SalesBookingAvailabilityDeps,
} from "./sales_booking_availability.ts";
import { emptyBookingFlow } from "./sales_booking_confirmation.ts";
import type { GhlDirectory } from "./sales_booking_owner_approval.ts";
import type {
  SalesBookingCase,
  SalesBookingDiaryEntry,
  SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import { salesBookingTravelMinutes } from "./sales_booking_travel.ts";

// Thu 24 Sep 2026 10:00 Perth. The week read is the next one: Tue 29 Sep
// (protected band 13:00-15:30) and Fri 2 Oct.
const NOW = new Date("2026-09-24T02:00:00Z");
const WEEK = {
  week_start: "2026-09-28",
  since: "2026-09-28T00:00:00+08:00",
  until_exclusive: "2026-10-05T00:00:00+08:00",
};
const MARNIN = "3S20LGVTjsVYy9vTJ9wM";
const NITHIN = "ERAycY7r6KZ8OA66WQCy";

const directory = (calendars: GhlDirectory["calendars"] = [
  {
    id: "dEQKVKHthsjSYaen1fiE",
    is_active: true,
    assigned_user_ids: ["tPNkSoHT4BorNCdfZWHe", MARNIN],
    assignments_returned: true,
  },
  {
    id: "RSQnT8cQdEE8azb5Chlq",
    is_active: true,
    assigned_user_ids: [NITHIN],
    assignments_returned: true,
  },
]) => ({
  calendars,
  users: [
    { id: MARNIN, email: "marnin@secureworkswa.com.au" },
    { id: NITHIN, email: "nithinsilas@outlook.com" },
  ],
});

const ok = <T>(value: T) => ({ ok: true as const, value });
const bad = (reason: string) => ({ ok: false as const, reason });

const lead = (id: string, contact: string, suburb: string) =>
  ({
    id,
    opportunity_id: id,
    contact_id: contact,
    resource_id: "marnin",
    suburb,
  }) as unknown as SalesBookingCase;

function input(o: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    resource: "marnin",
    week: WEEK,
    now: NOW,
    directory: ok(directory()),
    events: ok([]),
    blocked: ok([]),
    outlook: { state: "not_configured", reason: null, entries: [] },
    census: ok({
      offers: [],
      unverified_texts: [],
      unsettled_messages: [],
      booked: {},
    }),
    cases: [lead("opp:a", "c-a", "Hillarys")],
    ...o,
  };
}

const friday = (r: ReturnType<typeof computeSalesBookingAvailability>) =>
  r.free_times!.days.find((d: { date: string }) => d.date === "2026-10-02");
const windows = (d: { arrival_windows: Array<Record<string, unknown>> }) =>
  d.arrival_windows.map((w) => [
    String(w.from_iso).slice(11, 16),
    String(w.to_iso).slice(11, 16),
  ]);

Deno.test("travel: straight-line estimates require both locations", () => {
  assertEquals(salesBookingTravelMinutes("Duncraig", "Hillarys").minutes, 15);
  assertEquals(
    salesBookingTravelMinutes("12 Smith St, Duncraig WA 6023", "Hillarys")
      .basis,
    "straight_line",
  );
  const far = salesBookingTravelMinutes("Duncraig", "Canning Vale");
  assertEquals([far.basis, far.minutes], ["straight_line", 50]);
  const unknown = salesBookingTravelMinutes("Atlantis", "Hillarys");
  assertEquals([unknown.basis, unknown.minutes], ["unknown_location", null]);
  assertEquals(salesBookingTravelMinutes(null, "Hillarys").minutes, null);
  const sameSuburb = salesBookingTravelMinutes("Hillarys", "Hillarys");
  assertEquals(
    [sameSuburb.basis, sameSuburb.minutes],
    ["same_suburb_minimum", 15],
  );
  assertEquals(
    salesBookingTravelMinutes(
      "5 Somewhere Rd, Canning Vale WA 6155",
      "70 Other St, Canning Vale",
    ).minutes,
    15,
  );
  assertEquals(
    salesBookingTravelMinutes(
      "5 Somewhere Rd, Canning Vale WA 6155",
      "5 Somewhere Rd, Canning Vale",
    ).minutes,
    5,
  );
});

Deno.test("an empty diary reads as read, and every bookable day is free 08:00 to 16:00 arrivals", () => {
  const r = computeSalesBookingAvailability(input());
  assertEquals(r.calendar_read.state, "read");
  assertEquals(r.calendar_read.provider, "ghl");
  assertEquals(r.calendar_read.calendars, ["dEQKVKHthsjSYaen1fiE"]);
  assertEquals(r.calendar_read.occupied_intervals, []);
  assertEquals(r.commitments, []);
  assertEquals(r.commitments_read.state, "read");
  assertEquals(
    r.free_times!.days.map((d: { date: string }) => d.date),
    ["2026-09-29", "2026-10-02"],
  );
  // Last arrival leaves 30 minutes on site before 16:30.
  assertEquals(windows(friday(r)), [["08:00", "16:00"]]);
  assertEquals(r.free_times!.rule.on_site_minutes, 30);
  // Tuesday: protected band 13:00-15:30 with its 30-minute buffer each side.
  const tue = r.free_times!.days[0];
  assertEquals(windows(tue), [["08:00", "12:00"], ["16:00", "16:00"]]);
});

Deno.test("a visit fits 30 minutes on site plus travel to and from the neighbouring bookings", () => {
  const r = computeSalesBookingAvailability(input({
    events: ok([{
      id: "ev-1",
      startTime: "2026-10-02T10:00:00+08:00",
      endTime: "2026-10-02T11:00:00+08:00",
      assignedUserId: MARNIN,
      address: "5 Somewhere Rd, Duncraig WA 6023",
    }]),
  }));
  assertEquals(windows(friday(r)), []);
  // For the Hillarys lead: Duncraig is 15 minutes away.
  const own = r.case_free_times["opp:a"].days.find((d: { date: string }) =>
    d.date === "2026-10-02"
  );
  assertEquals(windows(own), [["08:00", "09:15"], ["11:15", "16:00"]]);
  assertEquals(own.state, "open");
  assertEquals(own.arrival_windows[0].travel_after_minutes, 15);
  assertEquals(own.arrival_windows[1].travel_before_minutes, 15);
  assertEquals(r.calendar_read.ghl_events, 1);
});

Deno.test("an unlocated neighboring event withholds arrival windows", () => {
  const r = computeSalesBookingAvailability(input({
    events: ok([{
      id: "ev-unknown",
      startTime: "2026-10-02T10:00:00+08:00",
      endTime: "2026-10-02T11:00:00+08:00",
      assignedUserId: MARNIN,
      contactId: "outside-current-cases",
    }]),
  }));
  assertEquals(r.calendar_read.state, "read");
  assertEquals(windows(friday(r)), []);
  assertEquals(friday(r).state, "travel_unknown");
  const caseDay = r.case_free_times["opp:a"].days.find((d: { date: string }) =>
    d.date === "2026-10-02"
  );
  assert(caseDay);
  assertEquals(windows(caseDay), []);
  assertEquals(caseDay.state, "travel_unknown");
});

Deno.test("a contact with cases in different suburbs cannot locate its event", () => {
  const r = computeSalesBookingAvailability(input({
    cases: [
      lead("opp:a", "shared-contact", "Canning Vale"),
      lead("opp:b", "shared-contact", "Duncraig"),
    ],
    events: ok([{
      id: "ev-shared-contact",
      startTime: "2026-10-02T10:00:00+08:00",
      endTime: "2026-10-02T11:00:00+08:00",
      assignedUserId: MARNIN,
      contactId: "shared-contact",
    }]),
  }));
  assertEquals(r.calendar_read.occupied_intervals[0].location, null);
  assertEquals(windows(friday(r)), []);
});

Deno.test("other assignees and cancelled rows never block; blocked-off time does", () => {
  const r = computeSalesBookingAvailability(input({
    events: ok([
      {
        id: "other",
        startTime: "2026-10-02T09:00:00+08:00",
        endTime: "2026-10-02T12:00:00+08:00",
        assignedUserId: "tPNkSoHT4BorNCdfZWHe",
      },
      {
        id: "gone",
        startTime: "2026-10-02T09:00:00+08:00",
        endTime: "2026-10-02T12:00:00+08:00",
        assignedUserId: MARNIN,
        appointmentStatus: "cancelled",
      },
    ]),
    blocked: ok([{
      id: "blk",
      startTime: "2026-10-02T13:00:00+08:00",
      endTime: "2026-10-02T16:30:00+08:00",
      assignedUserId: MARNIN,
    }]),
  }));
  assertEquals(windows(friday(r)), []);
  assertEquals(r.calendar_read.ghl_blocked_slots, 1);
});

Deno.test("Outlook events already read for the diary are busy too, and ones missing from GHL are counted", () => {
  const entry: SalesBookingDiaryEntry = {
    event_id: "o1",
    start: "2026-10-02T08:00:00+08:00",
    end: "2026-10-02T16:30:00+08:00",
    title: "SecureWorks",
    kind: "busy",
    source: "outlook",
    show_as: "busy",
    blocks_capacity: true,
    is_all_day: false,
    location: null,
    title_withheld: false,
    mirror_of_ghl_event_id: null,
  };
  const r = computeSalesBookingAvailability(input({
    outlook: { state: "read", reason: null, entries: [entry] },
    events: ok([{
      id: "unrelated-ghl-event",
      startTime: "2026-10-02T09:30:00+08:00",
      endTime: "2026-10-02T10:30:00+08:00",
      assignedUserId: MARNIN,
    }]),
  }));
  assertEquals(friday(r).state, "no_time_left");
  assertEquals(r.calendar_read.outlook, {
    state: "read",
    events: 1,
    not_in_ghl: 1,
  });
  const mirrored = computeSalesBookingAvailability(input({
    outlook: {
      state: "read",
      reason: null,
      entries: [{ ...entry, mirror_of_ghl_event_id: "ghl-mirror" }],
    },
    events: ok([{
      id: "ghl-mirror",
      startTime: entry.start,
      endTime: entry.end,
      assignedUserId: MARNIN,
    }]),
  }));
  assertEquals(mirrored.calendar_read.outlook.not_in_ghl, 0);
  const blockedOnly = computeSalesBookingAvailability(input({
    outlook: { state: "read", reason: null, entries: [entry] },
    blocked: ok([{
      id: "blocked-window",
      startTime: entry.start,
      endTime: entry.end,
      assignedUserId: MARNIN,
    }]),
  }));
  assertEquals(blockedOnly.calendar_read.outlook.not_in_ghl, 1);
  // A failed Outlook read is a named caveat; GHL is still the source.
  const failed = computeSalesBookingAvailability(input({
    outlook: {
      state: "failed",
      reason: "outlook_calendar_http_403",
      entries: [],
    },
  }));
  assertEquals(failed.calendar_read.state, "read");
  assertEquals(failed.calendar_read.caveats, [
    "outlook_unread: outlook_calendar_http_403",
  ]);
});

Deno.test("each unreadable GHL source is a named reason for that person, never a free week", () => {
  const cases: Array<[Partial<AvailabilityInput>, string, string]> = [
    [
      { directory: bad("http 401") },
      "could_not_read",
      "ghl_calendar_directory_unreadable: http 401",
    ],
    [
      { events: bad("ghl_events_incomplete") },
      "could_not_read",
      "ghl_events_unreadable: ghl_events_incomplete",
    ],
    [
      { blocked: bad("http 403") },
      "could_not_read",
      "ghl_blocked_slots_unreadable: http 403",
    ],
    [
      {
        directory: ok({
          ...directory(),
          users: [{ id: "someone", email: "marnin@secureworkswa.com.au" }],
        }),
      },
      "could_not_read",
      "ghl_user_not_confirmed",
    ],
    [
      {
        events: ok([{
          id: "x",
          startTime: "nope",
          endTime: "2026-10-02T11:00:00+08:00",
          assignedUserId: MARNIN,
        }]),
      },
      "could_not_read",
      "ghl_event_times_malformed",
    ],
  ];
  for (const [o, state, reason] of cases) {
    const r = computeSalesBookingAvailability(input(o));
    assertEquals([r.calendar_read.state, r.calendar_read.reason], [
      state,
      reason,
    ]);
    assertEquals(r.calendar_read.occupied_intervals, null);
    assertEquals(r.free_times, null);
    assertEquals(r.commitments, null);
  }
});

Deno.test("a person with no GHL calendar is told plainly, for that person only", () => {
  const r = computeSalesBookingAvailability(input({
    resource: "nithin",
    directory: ok(directory([{
      id: "dEQKVKHthsjSYaen1fiE",
      is_active: true,
      assigned_user_ids: [MARNIN],
      assignments_returned: true,
    }])),
  }));
  assertEquals(r.calendar_read.state, "not_configured");
  assertEquals(r.calendar_read.reason, "person_has_no_ghl_calendar");
  assertEquals(r.calendar_read.person, "Nithin");
  // Marnin on the same directory still reads.
  assertEquals(
    computeSalesBookingAvailability(input({
      directory: ok(directory([{
        id: "dEQKVKHthsjSYaen1fiE",
        is_active: true,
        assigned_user_ids: [MARNIN],
        assignments_returned: true,
      }])),
    })).calendar_read.state,
    "read",
  );
});

Deno.test("availability requires a confirmed-active GHL calendar", () => {
  const r = computeSalesBookingAvailability(input({
    directory: ok(directory([{
      id: "dEQKVKHthsjSYaen1fiE",
      is_active: null,
      assigned_user_ids: [MARNIN],
      assignments_returned: true,
    }])),
  }));
  assertEquals(r.calendar_read.state, "not_configured");
  assertEquals(r.calendar_read.reason, "person_has_no_ghl_calendar");
  assertEquals(r.free_times, null);
});

Deno.test("open offers come from the census, block their slot, and drop once that lead is booked in GHL", () => {
  const census = ok({
    offers: [
      {
        contact_id: "c-b",
        start_iso: "2026-10-02T09:00:00+08:00",
        end_iso: "2026-10-02T11:00:00+08:00",
        source: "system_text" as const,
        binding_hash: "h1",
      },
      {
        contact_id: "c-booked",
        start_iso: "2026-10-02T13:00:00+08:00",
        end_iso: "2026-10-02T14:30:00+08:00",
        source: "owner_approval" as const,
        binding_hash: "h2",
      },
    ],
    unverified_texts: [],
    unsettled_messages: [],
    booked: {},
  });
  const r = computeSalesBookingAvailability(input({
    census,
    cases: [
      lead("opp:a", "c-a", "Hillarys"),
      lead("opp:b", "c-b", "Hillarys"),
    ],
    events: ok([{
      id: "ev-booked",
      startTime: "2026-10-05T09:00:00+08:00",
      endTime: "2026-10-05T10:00:00+08:00",
      assignedUserId: MARNIN,
      contactId: "c-booked",
    }]),
  }));
  assertEquals(r.commitments!.map((c) => [c.id, c.contact_id, c.state]), [
    ["h1", "c-b", "offered"],
  ]);
  assertEquals(r.commitments_read.booked_in_ghl_dropped, 1);
  // Different visits in Hillarys use the 15-minute minimum.
  const forA = r.case_free_times["opp:a"].days.find((d: { date: string }) =>
    d.date === "2026-10-02"
  );
  assertEquals(windows(forA), [["08:00", "08:15"], ["11:15", "16:00"]]);
  // The offered lead's own offer does not block their own free times.
  const forB = r.case_free_times["opp:b"].days.find((d: { date: string }) =>
    d.date === "2026-10-02"
  );
  assertEquals(windows(forB), [["08:00", "16:00"]]);
});

Deno.test("an unreadable offer census keeps commitments null (unknown) while the calendar still reads", () => {
  const r = computeSalesBookingAvailability(
    input({ census: bad("unreadable") }),
  );
  assertEquals(r.calendar_read.state, "read");
  assertEquals(r.commitments, null);
  assertEquals(r.free_times, null);
  assertEquals(r.case_free_times, {});
  assertEquals(r.commitments_read.state, "could_not_read");
  assertEquals(
    r.commitments_read.reason,
    "system_offers_unreadable: unreadable",
  );
});

Deno.test("case capacity excludes that lead's own open offer", () => {
  const events = Array.from({ length: 5 }, (_, i) => ({
    id: `visit-${i}`,
    startTime: `2026-10-02T${String(9 + i).padStart(2, "0")}:00:00+08:00`,
    endTime: `2026-10-02T${String(9 + i).padStart(2, "0")}:30:00+08:00`,
    assignedUserId: MARNIN,
    address: "5 Main St, Hillarys",
  }));
  const r = computeSalesBookingAvailability(input({
    events: ok(events),
    census: ok({
      offers: [{
        contact_id: "c-a",
        start_iso: "2026-10-02T09:00:00+08:00",
        end_iso: "2026-10-02T10:00:00+08:00",
        source: "system_text" as const,
        binding_hash: "own-offer",
      }],
      unverified_texts: [],
      unsettled_messages: [],
      booked: {},
    }),
  }));
  assertEquals(friday(r).state, "full");
  const ownDay = r.case_free_times["opp:a"].days.find((d: { date: string }) =>
    d.date === "2026-10-02"
  );
  assertEquals(ownDay.state, "open");
  assert(windows(ownDay).length > 0);
});

Deno.test("a day at its visit cap is full", () => {
  const events = Array.from({ length: 6 }, (_, i) => ({
    id: `ev-${i}`,
    startTime: `2026-10-02T0${8 + (i % 2)}:00:00+08:00`,
    endTime: `2026-10-02T0${8 + (i % 2)}:10:00+08:00`,
    assignedUserId: MARNIN,
  }));
  const r = computeSalesBookingAvailability(input({ events: ok(events) }));
  assertEquals(friday(r).state, "full");
  assertEquals(friday(r).arrival_windows, []);
});

Deno.test("passed days have no free times", () => {
  const r = computeSalesBookingAvailability(input({
    week: {
      week_start: "2026-09-21",
      since: "2026-09-21T00:00:00+08:00",
      until_exclusive: "2026-09-28T00:00:00+08:00",
    },
  }));
  const [tue, fri] = r.free_times!.days;
  assertEquals(tue.state, "past");
  assertEquals(fri.state, "open");
});

function readResponse(): SalesBookingReadResponse {
  return {
    resource: { resource_id: "marnin" },
    week: { ...WEEK, timezone: "Australia/Perth" },
    week_start: WEEK.week_start,
    booking_flow: emptyBookingFlow(),
    diary: [],
    diary_read: {
      sources: {
        outlook: {
          state: "read",
          read_ok: true,
          reason: null,
          malformed_dropped: 0,
        },
      },
    },
    cases: [lead("opp:a", "c-a", "Hillarys")],
  } as unknown as SalesBookingReadResponse;
}

function liveDeps(o: Partial<SalesBookingAvailabilityDeps> = {}) {
  const calls: string[] = [];
  const deps: SalesBookingAvailabilityDeps = {
    readGhlDirectory: () => Promise.resolve(directory()),
    readGhlEvents: (selector) => {
      calls.push(JSON.stringify(selector));
      return Promise.resolve([]);
    },
    readGhlBlockedSlots: (userId) => {
      calls.push(`blocked:${userId}`);
      return Promise.resolve([]);
    },
    readSystemOfferRecords: (since) => {
      calls.push(`offers:${since}`);
      return Promise.resolve({ executions: [], approvals: [] });
    },
    now: () => NOW,
    ...o,
  };
  return { deps, calls };
}

Deno.test("the live read replaces the hard-coded not-connected banner reason", async () => {
  const before = readResponse();
  assertEquals(
    before.booking_flow!.calendar_read.reason,
    "person_wide_calendars_and_prior_offer_ledger_not_connected",
  );
  const { deps, calls } = liveDeps();
  const after = await applySalesBookingAvailability(before, deps);
  const flow = after.booking_flow!;
  assertEquals(flow.calendar_read.state, "read");
  assertEquals(flow.calendar_read.reason, null);
  assert(Array.isArray(flow.commitments));
  assert(!("published_calendar_read" in flow));
  assert(after.cases[0].free_times);
  // User-id window, then each calendar the person is on, then blocked time.
  assertEquals(calls.slice(0, 3), [
    JSON.stringify({ userId: MARNIN }),
    JSON.stringify({ calendarId: "dEQKVKHthsjSYaen1fiE", userId: MARNIN }),
    `blocked:${MARNIN}`,
  ]);
  assertEquals(calls[3], "offers:2026-09-03T02:00:00.000Z");
});

Deno.test("a partial Outlook diary read names the gap and withholds free times", async () => {
  const response = readResponse();
  response.diary_read.sources.outlook.malformed_dropped = 1;
  const { deps } = liveDeps();
  const after = await applySalesBookingAvailability(response, deps);
  assertEquals(after.booking_flow!.calendar_read.state, "read");
  assertEquals(after.booking_flow!.calendar_read.caveats, [
    "outlook_malformed_dropped: 1",
  ]);
  assertEquals(after.booking_flow!.free_times, null);
  assertEquals(after.cases[0].free_times, null);
});

Deno.test("a throwing reader is a named reason on the banner, never an exception", async () => {
  const { deps } = liveDeps({
    readGhlDirectory: () =>
      Promise.reject(new Error("ghl_calendars_incomplete")),
  });
  const after = await applySalesBookingAvailability(readResponse(), deps);
  assertEquals(after.booking_flow!.calendar_read.state, "could_not_read");
  assertEquals(
    after.booking_flow!.calendar_read.reason,
    "ghl_calendar_directory_unreadable: ghl_calendars_incomplete",
  );
  assertEquals(after.booking_flow!.commitments, null);
});

Deno.test("an unreadable offer census withholds generic and case free times", async () => {
  const { deps } = liveDeps({
    readSystemOfferRecords: () => Promise.reject(new Error("ledger unavailable")),
  });
  const after = await applySalesBookingAvailability(readResponse(), deps);
  assertEquals(after.booking_flow!.calendar_read.state, "read");
  assertEquals(after.booking_flow!.commitments_read.reason,
    "system_offers_unreadable: ledger unavailable");
  assertEquals(after.booking_flow!.free_times, null);
  assertEquals(after.cases[0].free_times, null);
});
