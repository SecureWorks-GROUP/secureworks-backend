/**
 * sales_booking_read — shaping, template-marker and coverage-honesty regressions.
 *
 * What these prove:
 *  - The response keeps the reference shape the Sales Booking view already
 *    consumes (`scripts/sales-booking-local-api.mjs` on secureworks-ux
 *    `patio/sales-booking-20260912`), plus `diary[]` and `thread_facts{}`.
 *  - An auto-ack / missed-call template is never a human reply, never starts
 *    the quiet window, and never makes a case look answered.
 *  - An unread calendar and an unread thread degrade THEIR OWN item, name the
 *    gap, and never throw or empty the rest of the response.
 *  - The action writes nothing: every dependency is a reader and the fakes
 *    below would fail loudly if a write were attempted.
 *
 * What these do NOT prove: that GHL accepts the live request shapes, or that
 * production credentials exist. Those need a live read.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assembleSalesBookingRead,
  createSalesBookingReadDependencies,
  defaultPerthWeekStart,
  deriveSalesBookingThreadFacts,
  isPhoneLikeName,
  isSalesBookingTemplateBody,
  perthGraphInstant,
  perthWeekWindow,
  projectSalesBookingCase,
  projectSalesBookingDiaryEntry,
  readSalesBookingGhlDiary,
  readSalesBookingThreadMessages,
  resolveSalesBookingGhlMapping,
  SALES_BOOKING_API_VERSION,
  SALES_BOOKING_CAPTAIN_DEFAULTS,
  SALES_BOOKING_GHL_USERS,
  SALES_BOOKING_RESOURCES,
  type SalesBookingDiaryScan,
  type SalesBookingMessage,
  salesBookingRead,
  type SalesBookingReadDependencies,
  SalesBookingRequestError,
} from "./sales_booking_read.ts";

const NOW = new Date("2026-09-16T02:00:00.000Z"); // Wed 10:00 Perth
const WEEK = "2026-09-14"; // Monday

// ── Fixtures ────────────────────────────────────────────────

function opportunity(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "opp-1",
    name: "Jane Smith",
    pipelineStageId: "stage-a",
    status: "open",
    updatedAt: "2026-09-15T01:00:00.000Z",
    contact: {
      id: "contact-1",
      name: "Jane Smith",
      city: "Canning Vale",
      tags: ["stratco"],
    },
    ...overrides,
  };
}

function ghlEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "evt-1",
    title: "Scope visit - Beckenham",
    startTime: "2026-09-15T10:00:00+08:00",
    endTime: "2026-09-15T11:30:00+08:00",
    address: "12 Example St",
    appointmentStatus: "confirmed",
    deleted: false,
    ...overrides,
  };
}

/** A dependency set whose every member is a reader; no write seam exists. */
function deps(
  overrides: Partial<SalesBookingReadDependencies> = {},
): SalesBookingReadDependencies {
  return {
    readOpportunities: () =>
      Promise.resolve({
        opportunities: [opportunity()],
        stages: { "stage-a": "New Lead" },
        exhausted: true,
        pages_scanned: 1,
        total: 1,
        reason: null,
      }),
    readDiary: () =>
      Promise.resolve({
        read_ok: true,
        reason: null,
        entries: [projectSalesBookingDiaryEntry(ghlEvent())!],
        malformed_dropped: 0,
        calendar_email: "marnin@secureworkswa.com.au",
        ghl_user_id: "ghl_user_marnin",
        scoper_user_id: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
      }),
    readThread: () => Promise.resolve([] as SalesBookingMessage[]),
    now: () => NOW,
    ...overrides,
  };
}

const UNREAD_DIARY: SalesBookingDiaryScan = {
  read_ok: false,
  reason: "ghl_calendar_page_failed: GHL 502",
  entries: [],
  malformed_dropped: 0,
  calendar_email: "marnin@secureworkswa.com.au",
  ghl_user_id: "ghl_user_marnin",
  scoper_user_id: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
};

// ── Week window ─────────────────────────────────────────────

Deno.test("perthWeekWindow spans Monday to the following Monday in Perth", () => {
  const week = perthWeekWindow(WEEK);
  assertEquals(week.since, "2026-09-14T00:00:00+08:00");
  assertEquals(week.until_exclusive, "2026-09-21T00:00:00+08:00");
  assertEquals(week.timezone, "Australia/Perth");
});

Deno.test("perthWeekWindow refuses a non-Monday and an impossible date", () => {
  // A week grid anchored on the wrong day mis-places every diary block.
  assertEquals(
    (() => {
      try {
        perthWeekWindow("2026-09-15");
        return "no throw";
      } catch (e) {
        return (e as Error).message;
      }
    })().includes("Monday"),
    true,
  );
  assertEquals(
    (() => {
      try {
        perthWeekWindow("2026-02-31");
        return "no throw";
      } catch (e) {
        return (e as Error).message;
      }
    })().includes("not a real date"),
    true,
  );
});

Deno.test("defaultPerthWeekStart reads the Perth wall clock, not UTC", () => {
  // 2026-09-13T17:30Z is Sunday in UTC but Monday 01:30 in Perth: the Perth
  // week has already rolled over.
  assertEquals(
    defaultPerthWeekStart(new Date("2026-09-13T17:30:00Z")),
    "2026-09-14",
  );
  assertEquals(
    defaultPerthWeekStart(new Date("2026-09-13T15:00:00Z")),
    "2026-09-07",
  );
  assertEquals(defaultPerthWeekStart(NOW), "2026-09-14");
});

// ── Template markers ────────────────────────────────────────

Deno.test("template markers match case-insensitively across line wrapping", () => {
  assert(isSalesBookingTemplateBody("Thanks for reaching out to SecureWorks!"));
  assert(
    isSalesBookingTemplateBody(
      "Sorry we missed your\n  call, we will ring back.",
    ),
  );
  assert(
    !isSalesBookingTemplateBody(
      "Hi Jane, can I come Tuesday between 10 and 11:30?",
    ),
  );
  assert(!isSalesBookingTemplateBody(""));
  assert(!isSalesBookingTemplateBody(null));
});

Deno.test("FIXTURE: a template-only thread is not an answered thread", () => {
  // The whole outbound side is automation. The customer's inbound is still the
  // latest human word, so the case must read as ours to action, the quiet
  // window must NOT be running, and last_human_outbound_at must stay null.
  const messages: SalesBookingMessage[] = [
    {
      id: "m1",
      type: "TYPE_SMS",
      direction: "inbound",
      body: "Hi, after a quote for fencing",
      timestamp: "2026-09-16T01:00:00.000Z",
    },
    {
      id: "m2",
      type: "TYPE_SMS",
      direction: "outbound",
      body: "Thanks for reaching out to SecureWorks, we will be in touch.",
      timestamp: "2026-09-16T01:00:30.000Z",
    },
    {
      id: "m3",
      type: "TYPE_SMS",
      direction: "outbound",
      body: "Sorry we missed your call.",
      timestamp: "2026-09-16T01:05:00.000Z",
    },
  ];
  const facts = deriveSalesBookingThreadFacts({
    caseId: "opp-1",
    contactId: "contact-1",
    messages,
    nowMs: NOW.getTime(),
  });
  assertEquals(facts.last_human_outbound_at, null);
  assertEquals(facts.last_outbound_at, "2026-09-16T01:05:00.000Z");
  assertEquals(facts.last_inbound_at, "2026-09-16T01:00:00.000Z");
  assertEquals(facts.quiet_window, false);
  assertEquals(facts.classification, "needs_decision");
  assertEquals(facts.template_outbound_count, 2);
  assertEquals(facts.read_ok, true);
});

Deno.test("a real human outbound inside 20h is waiting_reply; outside it is follow_up_due", () => {
  const human = (timestamp: string): SalesBookingMessage[] => [
    {
      type: "TYPE_SMS",
      direction: "inbound",
      body: "keen",
      timestamp: "2026-09-14T01:00:00.000Z",
    },
    {
      type: "TYPE_SMS",
      direction: "outbound",
      body: "Can I come Tuesday between 10:00 and 11:30?",
      timestamp,
    },
  ];
  const inside = deriveSalesBookingThreadFacts({
    caseId: "c",
    contactId: "x",
    messages: human("2026-09-15T22:00:00.000Z"), // 4h before NOW
    nowMs: NOW.getTime(),
  });
  assertEquals(inside.classification, "waiting_reply");
  assertEquals(inside.quiet_window, true);

  const outside = deriveSalesBookingThreadFacts({
    caseId: "c",
    contactId: "x",
    messages: human("2026-09-15T01:00:00.000Z"), // 25h before NOW
    nowMs: NOW.getTime(),
  });
  assertEquals(outside.classification, "follow_up_due");
  assertEquals(outside.quiet_window, false);
});

Deno.test("an empty thread is ready_to_contact, and activity rows are not contact", () => {
  assertEquals(
    deriveSalesBookingThreadFacts({
      caseId: "c",
      contactId: "x",
      messages: [],
      nowMs: NOW.getTime(),
    })
      .classification,
    "ready_to_contact",
  );
  const facts = deriveSalesBookingThreadFacts({
    caseId: "c",
    contactId: "x",
    messages: [
      {
        type: "TYPE_ACTIVITY_OPPORTUNITY",
        direction: "outbound",
        body: "stage moved",
        timestamp: "2026-09-16T01:00:00.000Z",
      },
      { type: "TYPE_SMS", direction: "outbound", body: "hi", timestamp: "" },
    ],
    nowMs: NOW.getTime(),
  });
  assertEquals(facts.message_count, 0);
  assertEquals(facts.classification, "ready_to_contact");
});

Deno.test("direction falls back to userId exactly as ghl-proxy does", () => {
  const facts = deriveSalesBookingThreadFacts({
    caseId: "c",
    contactId: "x",
    messages: [
      {
        type: "TYPE_SMS",
        body: "ours",
        timestamp: "2026-09-16T00:00:00.000Z",
        userId: "user-9",
      },
      {
        type: "TYPE_SMS",
        body: "theirs",
        timestamp: "2026-09-15T00:00:00.000Z",
      },
    ],
    nowMs: NOW.getTime(),
  });
  assertEquals(facts.last_human_outbound_at, "2026-09-16T00:00:00.000Z");
  assertEquals(facts.last_inbound_at, "2026-09-15T00:00:00.000Z");
});

// ── Cases ───────────────────────────────────────────────────

Deno.test("projectSalesBookingCase never invents a suburb and hides a phone-like name", () => {
  assert(isPhoneLikeName("+61 400 111 222"));
  assert(isPhoneLikeName("0400111222"));
  assert(!isPhoneLikeName("Jane Smith"));

  const named = projectSalesBookingCase(opportunity(), "marnin", {
    "stage-a": "New Lead",
  })!;
  assertObjectMatch(named as unknown as Record<string, unknown>, {
    id: "opp-1",
    resource_id: "marnin",
    opportunity_id: "opp-1",
    contact_id: "contact-1",
    suburb: "Canning Vale",
    display_name: "Jane Smith",
    status: "needs_decision",
    stage_name: "New Lead",
  });
  assertEquals("status_source" in named, false);
  assertEquals(named.tags, ["stratco"]);

  const anonymous = projectSalesBookingCase(
    opportunity({ contact: { id: "c2", name: "+61 400 111 222" } }),
    "marnin",
  )!;
  assertEquals(anonymous.display_name, "Enquiry");
  assertEquals(anonymous.suburb, null); // absent city stays null, never guessed
  assertEquals(anonymous.stage_name, null);
  assertEquals(projectSalesBookingCase({ name: "no id" }, "marnin"), null);
});

Deno.test("case status stays at the reference default; classification lives only in thread_facts", async () => {
  const payload = await salesBookingRead(
    deps({
      readThread: () =>
        Promise.resolve([
          {
            type: "TYPE_SMS",
            direction: "outbound",
            body: "Can I come Tuesday between 10:00 and 11:30?",
            timestamp: "2026-09-15T22:00:00.000Z",
          },
        ]),
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.cases[0].status, "needs_decision");
  assertEquals("status_source" in payload.cases[0], false);
  assertEquals(payload.thread_facts["opp-1"].classification, "waiting_reply");
  assertEquals(payload.thread_facts["opp-1"].read_ok, true);
});

// ── Diary ───────────────────────────────────────────────────

Deno.test("perthGraphInstant stamps the Perth offset on an offset-less local datetime", () => {
  assertEquals(
    perthGraphInstant("2026-09-15T10:00:00.0000000"),
    "2026-09-15T10:00:00+08:00",
  );
  assertEquals(
    perthGraphInstant("2026-09-15T02:00:00Z"),
    "2026-09-15T02:00:00Z",
  );
  assertEquals(perthGraphInstant("not a date"), null);
  assertEquals(perthGraphInstant(undefined), null);
});

Deno.test("diary kind and blocks_capacity come from GHL status, never from title text", () => {
  const busy = projectSalesBookingDiaryEntry(ghlEvent())!;
  assertObjectMatch(busy as unknown as Record<string, unknown>, {
    event_id: "evt-1",
    start: "2026-09-15T10:00:00+08:00",
    end: "2026-09-15T11:30:00+08:00",
    title: "Scope visit - Beckenham",
    kind: "busy",
    source: "ghl_calendar",
    show_as: "confirmed",
    blocks_capacity: true,
    title_withheld: false,
  });

  const cancelled = projectSalesBookingDiaryEntry(
    ghlEvent({ appointmentStatus: "cancelled" }),
  )!;
  assertEquals(cancelled.show_as, "cancelled");
  assertEquals(cancelled.blocks_capacity, false);
  assertEquals(cancelled.kind, "busy");

  const booked = projectSalesBookingDiaryEntry(
    ghlEvent({ appointmentStatus: "booked" }),
  )!;
  assertEquals(booked.blocks_capacity, true);

  // A title that merely SAYS leave is not a leave fact.
  const worded = projectSalesBookingDiaryEntry(
    ghlEvent({ title: "Annual leave chat" }),
  )!;
  assertEquals(worded.kind, "busy");
  assertEquals(worded.blocks_capacity, true);

  const allDay = projectSalesBookingDiaryEntry(
    ghlEvent({
      id: "evt-all-day",
      title: "Public holiday",
      startTime: "2026-09-16T00:00:00+08:00",
      endTime: "2026-09-17T00:00:00+08:00",
      isAllDay: true,
      appointmentStatus: "confirmed",
    }),
  )!;
  assertEquals(allDay.is_all_day, true);
  assertEquals(allDay.blocks_capacity, true);

  assertEquals(projectSalesBookingDiaryEntry({ id: "x" }), null);
  assertEquals(projectSalesBookingDiaryEntry(ghlEvent({ id: "" })), null);
});

// ── Assembly / coverage honesty ─────────────────────────────

Deno.test("response keeps the reference shape the Sales Booking view consumes", async () => {
  const payload = await salesBookingRead(deps(), {
    resource: "marnin",
    week_start: WEEK,
  });
  assertEquals(payload.ok, true);
  assertEquals(payload.fixture, false);
  assertEquals(payload.send_hold, true);
  assertEquals(payload.version, SALES_BOOKING_API_VERSION);
  assertEquals(payload.week_start, WEEK);
  assertEquals(payload.policy.activation, "held");
  assertEquals(payload.drafts, {});
  assertEquals(payload.cases.length, 1);
  assertEquals(payload.coverage.full_population, true);
  assertEquals(payload.coverage.enumerated, 1);
  assertEquals(payload.coverage.total, 1);
  assertEquals(payload.coverage.operational_leave, "not_read");
  assert(payload.coverage.gaps.length >= 2);
  // The two additions the reskinned view needs.
  assertEquals(payload.diary.length, 1);
  assertEquals(Object.keys(payload.thread_facts), ["opp-1"]);
  // Captain defaults ride the response so they can be flipped without code reading.
  assertEquals(payload.defaults, SALES_BOOKING_CAPTAIN_DEFAULTS);
  assertEquals(payload.resource.sender_line, "776");
});

Deno.test("diary is the only calendar output; unread is diary_read plus coverage.gaps", async () => {
  const payload = await salesBookingRead(deps(), {
    resource: "marnin",
    week_start: WEEK,
  });
  assertEquals("events" in payload, false);
  assertEquals("calendar" in payload.resource, false);
  assertEquals(payload.diary.length, 1);
  assertEquals(payload.diary_read.read_ok, true);

  const unread = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(UNREAD_DIARY) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals("events" in unread, false);
  assertEquals("calendar" in unread.resource, false);
  assertEquals(unread.diary, []);
  assertEquals(unread.diary_read.read_ok, false);
  assertEquals(unread.coverage.diary_read_ok, false);
  assert(unread.coverage.gaps.some((g) => g.includes("ghl_calendar_page_failed")));
});

Deno.test("FIXTURE: an unread calendar names the gap and never throws", async () => {
  const payload = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(UNREAD_DIARY) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.ok, true);
  assertEquals(payload.diary, []);
  assertEquals(payload.diary_read.read_ok, false);
  assertEquals(payload.diary_read.reason, "ghl_calendar_page_failed: GHL 502");
  assertEquals(payload.coverage.diary_read_ok, false);
  // The cases side is untouched: a calendar fault is not a roster fault.
  assertEquals(payload.cases.length, 1);
  const gap = payload.coverage.gaps.find((g) => g.includes("calendar"))!;
  assertStringIncludes(gap, "ghl_calendar_page_failed");
  // Unread coverage is never spare capacity.
  assertStringIncludes(gap, "not free capacity");
});

const GHL_USERS_BODY = {
  users: [
    {
      id: "ghl_user_nithin",
      email: SALES_BOOKING_GHL_USERS.nithin.email,
      name: "Nithin",
    },
    {
      id: "ghl_user_marnin",
      email: SALES_BOOKING_GHL_USERS.marnin.email,
      name: "Marnin",
    },
  ],
};

function ghlDiaryGet(
  replies: Record<string, Record<string, unknown> | { throw: string }>,
) {
  return (path: string) => {
    const key = path.startsWith("/users/")
      ? "users"
      : path.startsWith("/calendars/events")
      ? "events"
      : path;
    const reply = replies[key];
    if (!reply) return Promise.reject(new Error(`unexpected GHL GET ${path}`));
    if ("throw" in reply && typeof reply.throw === "string") {
      return Promise.reject(new Error(reply.throw));
    }
    return Promise.resolve(reply);
  };
}

Deno.test("a GHL week with confirmed, cancelled and all-day entries keeps UI diary keys", async () => {
  const confirmed = projectSalesBookingDiaryEntry(ghlEvent())!;
  const cancelled = projectSalesBookingDiaryEntry(
    ghlEvent({
      id: "evt-cancelled",
      title: "Cancelled visit",
      appointmentStatus: "cancelled",
      startTime: "2026-09-15T13:00:00+08:00",
      endTime: "2026-09-15T14:00:00+08:00",
    }),
  )!;
  const allDay = projectSalesBookingDiaryEntry(
    ghlEvent({
      id: "evt-all-day",
      title: "Rostered day off",
      startTime: "2026-09-16T00:00:00+08:00",
      endTime: "2026-09-17T00:00:00+08:00",
      isAllDay: true,
      appointmentStatus: "confirmed",
    }),
  )!;
  const payload = await salesBookingRead(
    deps({
      readDiary: () =>
        Promise.resolve({
          read_ok: true,
          reason: null,
          entries: [confirmed, cancelled, allDay],
          malformed_dropped: 0,
          calendar_email: SALES_BOOKING_GHL_USERS.marnin.email,
          ghl_user_id: "ghl_user_marnin",
          scoper_user_id: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
        }),
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.diary_read.read_ok, true);
  assertEquals(payload.diary_read.source, "ghl_calendar");
  assertEquals(payload.diary_read.ghl_user_id, "ghl_user_marnin");
  assertEquals(payload.diary.map((row) => row.event_id), [
    "evt-1",
    "evt-cancelled",
    "evt-all-day",
  ]);
  assertEquals(payload.diary[0].blocks_capacity, true);
  assertEquals(payload.diary[0].show_as, "confirmed");
  assertEquals(payload.diary[1].blocks_capacity, false);
  assertEquals(payload.diary[1].show_as, "cancelled");
  assertEquals(payload.diary[2].is_all_day, true);
  for (const row of payload.diary) {
    assertEquals(row.source, "ghl_calendar");
    assert(
      [
        "event_id",
        "start",
        "end",
        "title",
        "kind",
        "source",
        "show_as",
        "blocks_capacity",
        "is_all_day",
        "location",
        "title_withheld",
      ].every((key) => key in row),
    );
  }
});

Deno.test("an unmapped scoper is diary_read.read_ok false with ghl_user_unmapped", async () => {
  assertEquals(
    resolveSalesBookingGhlMapping(
      "nithin",
      "00000000-0000-0000-0000-000000000000",
    ),
    null,
  );
  const scan = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({ users: GHL_USERS_BODY }),
    locationId: "loc",
    resourceId: "nithin",
    scoperUserId: "00000000-0000-0000-0000-000000000000",
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(scan.read_ok, false);
  assertEquals(scan.reason, "ghl_user_unmapped");
  assertEquals(scan.entries, []);
  assertEquals(scan.ghl_user_id, null);

  const payload = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(scan) }),
    { resource: "nithin", week_start: WEEK, scoper_user_id: "00000000-0000-0000-0000-000000000000" },
  );
  assertEquals(payload.diary_read.read_ok, false);
  assertEquals(payload.diary_read.reason, "ghl_user_unmapped");
  assertEquals(payload.diary_read.source, "ghl_calendar");
  assertEquals(payload.diary, []);
  assertEquals(payload.cases.length, 1);
});

Deno.test("a failed GHL events page is unread, never a free week", async () => {
  const scan = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: GHL_USERS_BODY,
      events: { throw: "GHL 502: upstream" },
    }),
    locationId: "loc",
    resourceId: "marnin",
    scoperUserId: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(scan.read_ok, false);
  assertStringIncludes(scan.reason || "", "ghl_calendar_page_failed");
  assertEquals(scan.entries, []);
  assertEquals(scan.ghl_user_id, "ghl_user_marnin");

  const payload = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(scan) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.diary_read.read_ok, false);
  assertEquals(payload.diary, []);
  assert(payload.coverage.gaps.some((g) => g.includes("not free capacity")));
});

Deno.test("a live GHL users+events fixture confirms the mapped email and projects the week", async () => {
  const scan = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: GHL_USERS_BODY,
      events: {
        events: [
          ghlEvent(),
          ghlEvent({
            id: "evt-cancelled",
            appointmentStatus: "cancelled",
            startTime: "2026-09-15T13:00:00+08:00",
            endTime: "2026-09-15T14:00:00+08:00",
          }),
          ghlEvent({
            id: "evt-all-day",
            isAllDay: true,
            startTime: "2026-09-16T00:00:00+08:00",
            endTime: "2026-09-17T00:00:00+08:00",
          }),
        ],
      },
    }),
    locationId: "loc",
    resourceId: "marnin",
    scoperUserId: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(scan.read_ok, true);
  assertEquals(scan.ghl_user_id, "ghl_user_marnin");
  assertEquals(scan.entries.length, 3);
  assertEquals(scan.entries[1].show_as, "cancelled");
  assertEquals(scan.entries[1].blocks_capacity, false);
  assertEquals(scan.entries[2].is_all_day, true);
});

Deno.test("readSalesBookingGhlDiary keeps a 100-event GHL window", async () => {
  const events = Array.from({ length: 100 }, (_, i) =>
    ghlEvent({
      id: `evt-${i}`,
      startTime: "2026-09-15T10:00:00+08:00",
      endTime: "2026-09-15T11:00:00+08:00",
    }));
  const scan = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: GHL_USERS_BODY,
      events: { events },
    }),
    locationId: "loc",
    resourceId: "marnin",
    scoperUserId: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(scan.read_ok, true);
  assertEquals(scan.reason, null);
  assertEquals(scan.entries.length, 100);
});

Deno.test("an unfinished roster scan is never reported as a complete book", () => {
  const payload = assembleSalesBookingRead({
    resource: SALES_BOOKING_RESOURCES.marnin,
    week: perthWeekWindow(WEEK),
    projectedCases: [],
    opportunities: {
      opportunities: [],
      stages: {},
      exhausted: false,
      pages_scanned: 20,
      total: 900,
      reason: "page cap 20 reached",
    },
    diary: UNREAD_DIARY,
    threads: {
      facts: {},
      attempted: 0,
      read_ok_count: 0,
      not_attempted: 0,
      budget_exhausted: false,
      enabled: true,
    },
  });
  assertEquals(payload.coverage.full_population, false);
  assertEquals(payload.coverage.enumerated, 0);
  assertStringIncludes(payload.coverage.gaps[0], "not a completed empty book");
  assert(payload.coverage.gaps.some((g) => g.includes("page cap 20 reached")));
});

Deno.test("a failed thread read degrades only that case and is named in coverage", async () => {
  const payload = await salesBookingRead(
    deps({
      readThread: () => Promise.reject(new Error("GHL 502: bad gateway")),
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.ok, true);
  const facts = payload.thread_facts["opp-1"];
  assertEquals(facts.read_ok, false);
  assertStringIncludes(facts.reason!, "GHL 502");
  assertEquals(facts.classification, "unread");
  assertEquals(payload.cases[0].status, "needs_decision");
  assertEquals("status_source" in payload.cases[0], false);
  assert(
    payload.coverage.gaps.some((g) => g.includes("thread read(s) failed")),
  );
});

Deno.test("an opportunity with no GHL contact is still a row, marked unread", async () => {
  const payload = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [opportunity({ contact: { name: "No Contact Id" } })],
          stages: {},
          exhausted: true,
          pages_scanned: 1,
          total: 1,
          reason: null,
        }),
      readThread: () => {
        throw new Error("readThread must not be called without a contact id");
      },
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.cases.length, 1);
  assertEquals(
    payload.thread_facts["opp-1"].reason,
    "no_ghl_contact_on_opportunity",
  );
  assertEquals(payload.thread_facts["opp-1"].read_ok, false);
});

Deno.test("thread_limit leaves the remainder unproved rather than unreported", async () => {
  const many = Array.from(
    { length: 5 },
    (_, i) =>
      opportunity({
        id: `opp-${i}`,
        contact: { id: `contact-${i}`, name: `Lead ${i}` },
      }),
  );
  const payload = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: many,
          stages: {},
          exhausted: true,
          pages_scanned: 1,
          total: 5,
          reason: null,
        }),
    }),
    { resource: "marnin", week_start: WEEK, thread_limit: 2 },
  );
  assertEquals(payload.cases.length, 5);
  assertEquals(Object.keys(payload.thread_facts).length, 2);
  assertEquals(payload.coverage.threads_read, 2);
  assert(
    payload.coverage.gaps.some((g) =>
      g.includes("3 case(s) had no thread read")
    ),
  );
  const unproved = payload.cases.filter((c) => !payload.thread_facts[c.id]);
  assertEquals(unproved.length, 3);
  for (const row of payload.cases) {
    assertEquals(row.status, "needs_decision");
  }
});

Deno.test("include_thread_facts:false skips every thread read and says so", async () => {
  const payload = await salesBookingRead(
    deps({
      readThread: () => {
        throw new Error(
          "readThread must not be called when thread facts are off",
        );
      },
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(payload.thread_facts, {});
  assert(
    payload.coverage.gaps.some((g) =>
      g.includes("Thread facts were not requested")
    ),
  );
});

// ── Request validation ──────────────────────────────────────

Deno.test("resource selects the lane's own pipeline and scoper; unknown refuses", async () => {
  const nithin = await salesBookingRead(deps(), {
    resource: "nithin",
    week_start: WEEK,
  });
  assertEquals(nithin.resource.pipeline_id, "OGZLpPPVWVarN94HL6af");
  assertEquals(nithin.resource.lane, "patio");
  assertEquals(nithin.resource.sender_line, "774");

  const marnin = await salesBookingRead(deps(), {
    resource: "marnin",
    week_start: WEEK,
  });
  assertEquals(marnin.resource.pipeline_id, "I9t8njpuR0Dm7B2NDcvI");
  assertEquals(marnin.resource.lane, "fencing");
  // Fencing and patio pipelines are never mixed.
  assert(marnin.resource.pipeline_id !== nithin.resource.pipeline_id);

  await assertRejects(
    () => salesBookingRead(deps(), { resource: "khairo", week_start: WEEK }),
    SalesBookingRequestError,
  );
  await assertRejects(
    () =>
      salesBookingRead(deps(), {
        resource: "marnin",
        week_start: "2026-09-15",
      }),
    SalesBookingRequestError,
  );
});

Deno.test("scoper_user_id overrides the resource default for the calendar read only", async () => {
  let seen = "";
  const payload = await salesBookingRead(
    deps({
      readDiary: (args) => {
        seen = args.scoperUserId;
        return Promise.resolve(UNREAD_DIARY);
      },
    }),
    {
      resource: "marnin",
      week_start: WEEK,
      scoper_user_id: "11111111-2222-3333-4444-555555555555",
    },
  );
  assertEquals(seen, "11111111-2222-3333-4444-555555555555");
  // The roster still comes from the resource's own pipeline.
  assertEquals(payload.resource.pipeline_id, "I9t8njpuR0Dm7B2NDcvI");
});

Deno.test("empty conversation search falls through to the contact list before deriving facts", async () => {
  const paths: string[] = [];
  const ghlGet = (path: string) => {
    paths.push(path);
    if (path.startsWith("/conversations/search")) {
      return Promise.resolve({ conversations: [] });
    }
    if (
      path.startsWith("/conversations?") && path.includes("contactId=contact-1")
    ) {
      return Promise.resolve({ conversations: [{ id: "conv-sms-1" }] });
    }
    if (path.includes("/conversations/conv-sms-1/messages")) {
      return Promise.resolve({
        messages: [
          {
            id: "m1",
            messageType: "TYPE_SMS",
            direction: "outbound",
            body: "Here is the quote for Tuesday",
            dateAdded: "2026-09-15T22:00:00.000Z",
          },
        ],
      });
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  };

  const messages = await readSalesBookingThreadMessages(
    ghlGet,
    "contact-1",
    "loc-1",
  );
  assertEquals(messages.length, 1);
  assertEquals(messages[0].body, "Here is the quote for Tuesday");
  assert(paths.some((p) => p.startsWith("/conversations/search")));
  assert(
    paths.some((p) =>
      p.startsWith("/conversations?") && p.includes("contactId=contact-1")
    ),
  );
  assert(paths.some((p) => p.includes("/conversations/conv-sms-1/messages")));

  const payload = await salesBookingRead(
    deps({
      readThread: ({ contactId }) =>
        readSalesBookingThreadMessages(ghlGet, contactId, "loc-1"),
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.cases[0].status, "needs_decision");
  assertEquals(payload.thread_facts["opp-1"].read_ok, true);
  assertEquals(payload.thread_facts["opp-1"].classification, "waiting_reply");
});

Deno.test("empty search and empty contact list is a new enquiry, not a failed read", async () => {
  const messages = await readSalesBookingThreadMessages(
    (path) => {
      if (path.startsWith("/conversations/search")) {
        return Promise.resolve({ conversations: [] });
      }
      if (path.startsWith("/conversations?")) {
        return Promise.resolve({ conversations: [] });
      }
      return Promise.reject(
        new Error(
          `messages must not be fetched without a conversation: ${path}`,
        ),
      );
    },
    "contact-new",
    "loc-1",
  );
  assertEquals(messages, []);

  const payload = await salesBookingRead(
    deps({ readThread: () => Promise.resolve(messages) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.thread_facts["opp-1"].read_ok, true);
  assertEquals(
    payload.thread_facts["opp-1"].classification,
    "ready_to_contact",
  );
});

Deno.test("a conversation search hit does not call the contact list fallback", async () => {
  const paths: string[] = [];
  await readSalesBookingThreadMessages(
    (path) => {
      paths.push(path);
      if (path.startsWith("/conversations/search")) {
        return Promise.resolve({ conversations: [{ id: "conv-1" }] });
      }
      if (path.includes("/conversations/conv-1/messages")) {
        return Promise.resolve({ messages: [] });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    },
    "contact-1",
    "loc-1",
  );
  assertEquals(
    paths.some((p) =>
      p.startsWith("/conversations?") && !p.startsWith("/conversations/search")
    ),
    false,
  );
});

Deno.test("week_start defaults to the current Perth week when omitted", async () => {
  const payload = await salesBookingRead(deps(), { resource: "marnin" });
  assertEquals(payload.week_start, "2026-09-14");
  assertEquals(payload.week.since, "2026-09-14T00:00:00+08:00");
});

// ── Structural: the action is read-only ─────────────────────

Deno.test("the deps object handed to the runner exposes no write members", async () => {
  const production = createSalesBookingReadDependencies({ from: () => ({}) });
  const forbidden = ["insert", "update", "upsert", "delete", "rpc"] as const;
  for (const name of forbidden) {
    assertEquals(Object.hasOwn(production, name), false);
  }
  assertEquals(
    Object.keys(production).sort(),
    ["now", "readDiary", "readOpportunities", "readThread"].sort(),
  );

  let handed: SalesBookingReadDependencies | undefined;
  const readers = deps();
  const captured: SalesBookingReadDependencies = {
    readOpportunities: (args) => {
      handed = captured;
      return readers.readOpportunities(args);
    },
    readDiary: (args) => {
      handed = captured;
      return readers.readDiary(args);
    },
    readThread: (args) => {
      handed = captured;
      return readers.readThread(args);
    },
    now: () => {
      handed = captured;
      return readers.now();
    },
  };
  await salesBookingRead(captured, { resource: "marnin", week_start: WEEK });
  assert(handed);
  for (const name of forbidden) {
    assertEquals(Object.hasOwn(handed, name), false);
  }
});
