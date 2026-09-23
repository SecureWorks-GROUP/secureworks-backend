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
 *  - Thread-facts and roster cache persist are the only writes; GHL stays read-only.
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
  applySalesBookingContactFact,
  assembleSalesBookingRead,
  cachedRosterFromScan,
  confirmSalesBookingGhlUser,
  createSalesBookingReadDependencies,
  defaultPerthWeekStart,
  deriveSalesBookingThreadFacts,
  isPhoneLikeName,
  isSalesBookingScopeStage,
  isSalesBookingTemplateBody,
  perthGraphInstant,
  perthWeekWindow,
  projectSalesBookingCase,
  projectSalesBookingDiaryEntry,
  readSalesBookingGhlDiary,
  readSalesBookingOpportunities,
  readSalesBookingThreadMessages,
  resolveSalesBookingGhlMapping,
  resolveSalesBookingRoster,
  SALES_BOOKING_API_VERSION,
  SALES_BOOKING_CAPTAIN_DEFAULTS,
  SALES_BOOKING_GHL_USERS,
  SALES_BOOKING_NOT_GIVEN,
  SALES_BOOKING_READ_BUDGET_MS,
  SALES_BOOKING_RESOURCES,
  SALES_BOOKING_ROSTER_KIND,
  SALES_BOOKING_THREAD_FACTS_KIND,
  SALES_BOOKING_THREAD_FACTS_WEEK_START,
  type SalesBookingCachedRoster,
  type SalesBookingCachedThreadFact,
  type SalesBookingDiaryScan,
  salesBookingGhl429DelayMs,
  salesBookingJobTypeFromOpportunity,
  type SalesBookingMessage,
  salesBookingRead,
  type SalesBookingReadDependencies,
  SalesBookingRequestError,
  salesBookingRosterIsComplete,
  salesBookingRosterIsFresh,
  salesBookingSuburbFromContact,
  salesBookingThreadFactIsFresh,
  withSalesBookingGhl429Retry,
} from "./sales_booking_read.ts";
import {
  confirmGhlUserId,
  ghlCalendarEventsAction,
  usersFromGhlBody,
} from "../ghl-proxy/calendar_events.ts";

const NOW = new Date("2026-09-16T02:00:00.000Z"); // Wed 10:00 Perth
const WEEK = "2026-09-14"; // Monday
const MARNIN_SCOPE_STAGE = SALES_BOOKING_RESOURCES.marnin.scope_stage_ids[0];
const NITHIN_SCOPE_STAGE = SALES_BOOKING_RESOURCES.nithin.scope_stage_ids[0];
/** Wiki fencing "Lead Closed (scope booked)" — still visit/reply/quote. */
const MARNIN_LEAD_CLOSED_STAGE = "09eeb872-fa46-41fc-a96b-8a8d2bc12215";
/** Wiki fencing "Following up Quote Sent (Site visit)" — past quote-to-send. */
const MARNIN_QUOTE_SENT_STAGE = "02476ea1-6ef4-4b73-80fa-7d685c016bf7";
/** Wiki fencing "On Hold". */
const MARNIN_ON_HOLD_STAGE = "9cae7ae3-142a-4864-9a2e-bb04a3fb94fb";

// ── Fixtures ────────────────────────────────────────────────

function opportunity(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "opp-1",
    name: "Jane Smith",
    pipelineStageId: MARNIN_SCOPE_STAGE,
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

function scopeStageForPipeline(pipelineId: string): string {
  if (pipelineId === SALES_BOOKING_RESOURCES.nithin.pipeline_id) {
    return NITHIN_SCOPE_STAGE;
  }
  return MARNIN_SCOPE_STAGE;
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
    ...overrides,
  };
}

/** Default fakes. Cache persist is optional; GHL members stay readers. */
function deps(
  overrides: Partial<SalesBookingReadDependencies> = {},
): SalesBookingReadDependencies {
  return {
    readOpportunities: ({ pipelineId }) => {
      const stageId = scopeStageForPipeline(pipelineId);
      return Promise.resolve({
        opportunities: [opportunity({ pipelineStageId: stageId })],
        stages: { [stageId]: "New Lead" },
        exhausted: true,
        pages_scanned: 1,
        total: 1,
        reason: null,
      });
    },
    readDiary: () =>
      Promise.resolve({
        read_ok: true,
        reason: null,
        entries: [projectSalesBookingDiaryEntry(ghlEvent())!],
        malformed_dropped: 0,
        calendar_email: "marnin@secureworkswa.com.au",
        ghl_user_id: "ghl_user_marnin",
        mapped_by: "email",
        scoper_user_id: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
      }),
    readOutlookDiary: () =>
      Promise.resolve({
        state: "read",
        read_ok: true,
        reason: null,
        entries: [],
        malformed_dropped: 0,
        calendar_email: "marnin@secureworkswa.com.au",
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
  mapped_by: "email",
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
    [MARNIN_SCOPE_STAGE]: "New Lead",
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
    job_type: "fencing",
    pipeline_stage_id: MARNIN_SCOPE_STAGE,
  });
  assertEquals("status_source" in named, false);
  assertEquals(named.tags, ["stratco"]);

  const anonymous = projectSalesBookingCase(
    opportunity({ contact: { id: "c2", name: "+61 400 111 222" } }),
    "marnin",
  )!;
  assertEquals(anonymous.display_name, "Enquiry");
  assertEquals(anonymous.suburb, SALES_BOOKING_NOT_GIVEN);
  assertEquals(anonymous.job_type, "fencing");
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
    source: "ghl",
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

Deno.test("diary projection reads only documented GHL event fields", () => {
  assertEquals(
    projectSalesBookingDiaryEntry({
      id: "alias-times",
      start: "2026-09-15T10:00:00+08:00",
      end: "2026-09-15T11:00:00+08:00",
      title: "Visit",
    }),
    null,
  );

  const aliases = projectSalesBookingDiaryEntry(ghlEvent({
    title: "",
    appointmentTitle: "Hidden title",
    address: "",
    location: "Hidden place",
    appointmentStatus: "",
    status: "cancelled",
    isAllDay: false,
    allDay: true,
  }))!;
  assertEquals(aliases.title, null);
  assertEquals(aliases.location, null);
  assertEquals(aliases.blocks_capacity, true);
  assertEquals(aliases.show_as, "busy");
  assertEquals(aliases.is_all_day, false);

  const midnightSpan = projectSalesBookingDiaryEntry(ghlEvent({
    id: "midnight-block",
    startTime: "2026-09-16T00:00:00+08:00",
    endTime: "2026-09-17T00:00:00+08:00",
    isAllDay: false,
    appointmentStatus: "confirmed",
  }))!;
  assertEquals(midnightSpan.is_all_day, false);
  assertEquals(midnightSpan.blocks_capacity, true);

  const deletedFlag = projectSalesBookingDiaryEntry(ghlEvent({
    deleted: true,
    appointmentStatus: "confirmed",
  }))!;
  assertEquals(deletedFlag.show_as, "confirmed");
  assertEquals(deletedFlag.blocks_capacity, true);
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
  assertEquals(payload.pack, { present: false, as_of: null, proposals: {} });
  assertEquals(payload.stamp.present, false);
  assertEquals(payload.cases.length, 1);
  assertEquals(payload.cases[0].proposal, null);
  assertEquals(payload.cases[0].stamp_state, "none");
  assertEquals(payload.coverage.full_population, true);
  assertEquals(payload.coverage.enumerated, 1);
  assertEquals(payload.coverage.total, 1);
  assertEquals(payload.coverage.excluded_by_stage, 0);
  // Marnin's Outlook primary calendar is read; other leave calendars are not.
  assertEquals(
    payload.coverage.operational_leave,
    "primary_outlook_calendar_only",
  );
  assertEquals(payload.coverage.roster_source, "live");
  assertEquals(payload.coverage.roster_age_ms, 0);
  assert(payload.coverage.gaps.length >= 2);
  // The two additions the reskinned view needs.
  assertEquals(payload.diary.length, 1);
  assertEquals(Object.keys(payload.thread_facts), ["opp-1"]);
  // Captain defaults ride the response so they can be flipped without code reading.
  assertEquals(payload.defaults, SALES_BOOKING_CAPTAIN_DEFAULTS);
  assertEquals(payload.resource.sender_line, "776");
});

Deno.test("unread mirrors diary_read onto resource.calendar so the Booking door paints the banner", async () => {
  const payload = await salesBookingRead(deps(), {
    resource: "marnin",
    week_start: WEEK,
  });
  assertEquals("events" in payload, false);
  assertEquals(payload.diary.length, 1);
  assertEquals(payload.diary_read.read_ok, true);
  assertEquals(payload.resource.calendar.ok, true);
  assertEquals(payload.resource.calendar.error, null);
  assertEquals(
    payload.resource.calendar.mailbox,
    "marnin@secureworkswa.com.au",
  );

  const unread = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(UNREAD_DIARY) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals("events" in unread, false);
  assertEquals(unread.diary, []);
  assertEquals(unread.diary_read.read_ok, false);
  assertEquals(unread.coverage.diary_read_ok, false);
  assert(
    unread.coverage.gaps.some((g) => g.includes("ghl_calendar_page_failed")),
  );
  // Live Booking door (ops-sales-booking.js renderCalendar) paints
  // "Calendar not connected" only when resource.calendar.ok === false.
  assertEquals(unread.resource.calendar.ok, false);
  assertEquals(
    unread.resource.calendar.error,
    "ghl_calendar_page_failed: GHL 502",
  );
  assertEquals(unread.resource.calendar.mailbox, "marnin@secureworkswa.com.au");
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
      firstName: "Nithin",
    },
    {
      id: "ghl_user_marnin",
      email: SALES_BOOKING_GHL_USERS.marnin.email,
      name: "Marnin",
      firstName: "Marnin",
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
          mapped_by: "email",
          scoper_user_id: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
        }),
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.diary_read.read_ok, true);
  assertEquals(payload.diary_read.source, "ghl+outlook");
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
    assertEquals(row.source, "ghl");
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
        "mirror_of_ghl_event_id",
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
    {
      resource: "nithin",
      week_start: WEEK,
      scoper_user_id: "00000000-0000-0000-0000-000000000000",
    },
  );
  assertEquals(payload.diary_read.read_ok, false);
  assertEquals(payload.diary_read.reason, "ghl_user_unmapped");
  // An unknown scoper has no Outlook mailbox either: GHL is the only source.
  assertEquals(payload.diary_read.source, "ghl");
  assertEquals(payload.diary_read.sources.outlook.state, "not_configured");
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
      cached_count: 0,
      fresh_count: 0,
      unread_count: 0,
      remaining_429_count: 0,
    },
  });
  assertEquals(payload.coverage.full_population, false);
  assertEquals(payload.coverage.enumerated, 0);
  assertEquals(payload.coverage.excluded_by_stage, 0);
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
    payload.coverage.gaps.some((g) => g.includes("thread(s) unread")),
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

Deno.test("isSalesBookingScopeStage admits an in-scope id and drops quote-sent, hold, and blank", () => {
  const scope = SALES_BOOKING_RESOURCES.marnin.scope_stage_ids;
  assertEquals(isSalesBookingScopeStage(MARNIN_SCOPE_STAGE, scope), true);
  assertEquals(isSalesBookingScopeStage(MARNIN_QUOTE_SENT_STAGE, scope), false);
  assertEquals(isSalesBookingScopeStage(MARNIN_ON_HOLD_STAGE, scope), false);
  assertEquals(isSalesBookingScopeStage("", scope), false);
});

Deno.test("FIXTURE: mixed pipeline stages exclude quote-sent/hold and spend the thread budget on newest in-scope first", async () => {
  const newestOutOfScope = opportunity({
    id: "opp-quote-sent",
    pipelineStageId: MARNIN_QUOTE_SENT_STAGE,
    updatedAt: "2026-09-16T04:00:00.000Z",
    contact: { id: "contact-quote-sent", name: "Quote Sent" },
  });
  const newestInScope = opportunity({
    id: "opp-new",
    pipelineStageId: MARNIN_SCOPE_STAGE,
    updatedAt: "2026-09-16T03:00:00.000Z",
    contact: { id: "contact-new", name: "New Lead" },
  });
  const olderInScope = opportunity({
    id: "opp-old",
    pipelineStageId: MARNIN_LEAD_CLOSED_STAGE, // Lead Closed (scope booked)
    updatedAt: "2026-09-14T01:00:00.000Z",
    contact: { id: "contact-old", name: "Older Booked" },
  });
  const onHold = opportunity({
    id: "opp-hold",
    pipelineStageId: MARNIN_ON_HOLD_STAGE,
    updatedAt: "2026-09-16T05:00:00.000Z",
    contact: { id: "contact-hold", name: "On Hold" },
  });
  const blankStage = opportunity({
    id: "opp-blank",
    pipelineStageId: "",
    updatedAt: "2026-09-16T06:00:00.000Z",
    contact: { id: "contact-blank", name: "Blank Stage" },
  });
  const attempted: string[] = [];
  const payload = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [
            newestOutOfScope,
            olderInScope,
            newestInScope,
            onHold,
            blankStage,
          ],
          stages: {
            [MARNIN_SCOPE_STAGE]: "New Lead (Call + Qualify)",
            [MARNIN_LEAD_CLOSED_STAGE]: "Lead Closed (scope booked)",
            [MARNIN_QUOTE_SENT_STAGE]: "Following up Quote Sent (Site visit)",
            [MARNIN_ON_HOLD_STAGE]: "On Hold",
          },
          exhausted: true,
          pages_scanned: 1,
          total: 5,
          reason: null,
        }),
      readThread: ({ contactId }) => {
        attempted.push(contactId);
        return Promise.resolve([] as SalesBookingMessage[]);
      },
    }),
    { resource: "marnin", week_start: WEEK, thread_limit: 1 },
  );

  assertEquals(payload.cases.map((row) => row.id), ["opp-old", "opp-new"]);
  assertEquals(payload.coverage.enumerated, 2);
  assertEquals(payload.coverage.excluded_by_stage, 3);
  assertEquals(payload.coverage.total, 5);
  assertEquals(Object.keys(payload.thread_facts), ["opp-new"]);
  assertEquals(attempted, ["contact-new"]);
  assertEquals(payload.coverage.threads_attempted, 1);
  assertEquals(payload.coverage.threads_read, 1);
  assert(
    payload.coverage.gaps.some((g) =>
      g.includes("1 case(s) had no thread read (row budget reached)")
    ),
  );
  assertEquals("opp-quote-sent" in payload.thread_facts, false);
  assertEquals("opp-hold" in payload.thread_facts, false);
});

Deno.test("FIXTURE: patio quote-sent stages are excluded from nithin's scoped book", async () => {
  const patioQuoteSent = "d2fb3af7-91e5-4317-b778-2be117341f07";
  const payload = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [
            opportunity({
              id: "opp-need-scope",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: { id: "contact-need", name: "Need Scope" },
            }),
            opportunity({
              id: "opp-quote-sent",
              pipelineStageId: patioQuoteSent,
              contact: { id: "contact-sent", name: "Quote Sent" },
            }),
          ],
          stages: {
            [NITHIN_SCOPE_STAGE]: "Client Needs To Be Contacted",
            [patioQuoteSent]: "Quote Sent / Follow up",
          },
          exhausted: true,
          pages_scanned: 1,
          total: 2,
          reason: null,
        }),
    }),
    { resource: "nithin", week_start: WEEK },
  );
  assertEquals(payload.cases.map((row) => row.id), ["opp-need-scope"]);
  assertEquals(payload.coverage.enumerated, 1);
  assertEquals(payload.coverage.excluded_by_stage, 1);
  assertEquals(Object.keys(payload.thread_facts), ["opp-need-scope"]);
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
  assertEquals(
    nithin.resource.scope_stage_ids,
    SALES_BOOKING_RESOURCES.nithin.scope_stage_ids,
  );

  const marnin = await salesBookingRead(deps(), {
    resource: "marnin",
    week_start: WEEK,
  });
  assertEquals(marnin.resource.pipeline_id, "I9t8njpuR0Dm7B2NDcvI");
  assertEquals(marnin.resource.lane, "fencing");
  // Fencing and patio pipelines are never mixed.
  assert(marnin.resource.pipeline_id !== nithin.resource.pipeline_id);

  assertEquals(SALES_BOOKING_RESOURCES.khairo, undefined);
  await assertRejects(
    () => salesBookingRead(deps(), { resource: "khairo", week_start: WEEK }),
    SalesBookingRequestError,
  );
  const { users: khairoUsers } = usersFromGhlBody({
    users: [
      { id: "ghl_user_khairo", email: "khairo@secureworkswa.com.au" },
      { id: "ghl_user_marnin", email: "marnin@secureworkswa.com.au" },
    ],
  });
  assertEquals(
    confirmGhlUserId({
      users: khairoUsers,
      email: "khairo@secureworkswa.com.au",
    }),
    { id: "ghl_user_khairo", reason: null },
  );
  const khairoCalls: string[] = [];
  const khairoDiary = await ghlCalendarEventsAction({
    method: "GET",
    params: new URLSearchParams({
      user_email: "khairo@secureworkswa.com.au",
      start: "2026-09-14T00:00:00+08:00",
      end: "2026-09-21T00:00:00+08:00",
    }),
    locationId: "loc_secureworks",
    ghlGet: (path) => {
      khairoCalls.push(path);
      if (path.includes("/users/")) {
        return Promise.resolve({
          users: [
            { id: "ghl_user_khairo", email: "khairo@secureworkswa.com.au" },
          ],
        });
      }
      return Promise.resolve({ events: [] });
    },
  });
  assertEquals(khairoDiary.status, 200);
  assertEquals(khairoDiary.body.ok, true);
  assertEquals(
    (khairoDiary.body.provenance as { user_id: string }).user_id,
    "ghl_user_khairo",
  );
  assertEquals(
    (khairoDiary.body.provenance as { dedicated_calendar: string })
      .dedicated_calendar,
    "unconfirmed",
  );
  assertEquals(
    (khairoDiary.body.provenance as { dedicated_calendar_id: string | null })
      .dedicated_calendar_id,
    null,
  );
  assertEquals(khairoCalls[0].includes("/users/"), true);
  assertEquals(khairoCalls.some((path) => path.includes("calendarId=")), false);
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
    [
      "loadRosterCache",
      "loadThreadFactsCache",
      "now",
      "persistRosterCache",
      "persistThreadFactsCache",
      "readContacts",
      "readDiary",
      "readJobSites",
      "readOpportunities",
      "readOutlookDiary",
      "readThread",
    ].sort(),
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

function cachedFact(
  overrides: Partial<SalesBookingCachedThreadFact> = {},
): SalesBookingCachedThreadFact {
  return {
    case_id: "opp-1",
    contact_id: "contact-1",
    read_ok: true,
    reason: null,
    last_inbound_at: null,
    last_human_outbound_at: "2026-09-15T00:00:00.000Z",
    last_outbound_at: "2026-09-15T00:00:00.000Z",
    quiet_window: false,
    quiet_hours: 20,
    classification: "follow_up_due",
    message_count: 1,
    template_outbound_count: 0,
    read_at: "2026-09-16T01:00:00.000Z",
    ...overrides,
  };
}

function cachedRoster(
  overrides: Partial<SalesBookingCachedRoster> = {},
): SalesBookingCachedRoster {
  return {
    opportunities: [opportunity()],
    stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
    exhausted: true,
    pages_scanned: 3,
    total: 1,
    reason: null,
    read_at: "2026-09-16T01:55:00.000Z",
    ...overrides,
  };
}

Deno.test("suburb comes from city or a WA address line; job_type from custom fields then tags", () => {
  assertEquals(
    salesBookingSuburbFromContact({ city: "Mosman Park" }),
    "Mosman Park",
  );
  assertEquals(
    salesBookingSuburbFromContact({
      address1: "12 Example St, Canning Vale WA 6155",
    }),
    "Canning Vale",
  );
  assertEquals(
    salesBookingSuburbFromContact({
      city: "18 heysen crest woodvale WA 6026",
    }),
    "woodvale",
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "2 Wedge Way, Merriwa" }),
    "Merriwa",
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "115 Berkley Rd" }),
    SALES_BOOKING_NOT_GIVEN,
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "8 ison court" }),
    SALES_BOOKING_NOT_GIVEN,
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "12 Delonix Circle" }),
    SALES_BOOKING_NOT_GIVEN,
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "Banksia Grove" }),
    "Banksia Grove",
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "St James" }),
    "St James",
  );
  assertEquals(
    salesBookingSuburbFromContact({
      city: "53 pensacola Ave Caversham 6055",
    }),
    "Caversham",
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "5 Skye Ct, Greenwood 6024" }),
    "Greenwood",
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "East Victoria Park, 6101" }),
    "East Victoria Park",
  );
  assertEquals(salesBookingSuburbFromContact({}), SALES_BOOKING_NOT_GIVEN);
  assertEquals(
    salesBookingJobTypeFromOpportunity({}, { tags: ["northside patios"] }),
    "patio",
  );
  assertEquals(
    salesBookingJobTypeFromOpportunity({}, { tags: ["sw fencing"] }),
    "fencing",
  );
  assertEquals(
    salesBookingJobTypeFromOpportunity({
      customFields: [{ key: "job_type", field_value: "Patio" }],
    }, { tags: ["sw fencing"] }),
    "patio",
  );
  assertEquals(
    salesBookingJobTypeFromOpportunity({
      customFields: [{ id: "cf-job", fieldValue: "Patio" }],
    }),
    "patio",
  );
  assertEquals(
    salesBookingJobTypeFromOpportunity({}, { tags: ["stratco"] }),
    SALES_BOOKING_NOT_GIVEN,
  );
  assertEquals(
    salesBookingJobTypeFromOpportunity({}, { tags: ["stratco"] }, "patio"),
    "patio",
  );
  const fromAddress = projectSalesBookingCase(
    opportunity({
      createdAt: "2026-09-10T02:00:00.000Z",
      contact: {
        id: "c-addr",
        name: "Pat",
        address1: "9 Reef Rd, Hillarys WA 6025",
        tags: ["northside patios"],
      },
    }),
    "nithin",
  )!;
  assertEquals(fromAddress.suburb, "Hillarys");
  assertEquals(fromAddress.job_type, "patio");
  assertEquals(fromAddress.enquiry_at, "2026-09-10T02:00:00.000Z");
  assertEquals(fromAddress.pipeline_stage_id, MARNIN_SCOPE_STAGE);
  assertEquals(
    salesBookingSuburbFromContact({ suburb: "Mosman Park" }),
    "Mosman Park",
  );
  assertEquals(
    salesBookingSuburbFromContact({ city: "5A Burdmam Way Balga W.A" }),
    "Balga",
  );
  assertEquals(
    salesBookingSuburbFromContact({}, {
      customFields: [{
        id: "cf-uuid",
        fieldValue: "9 Reef Rd, Hillarys WA 6025",
      }],
    }),
    "Hillarys",
  );
  assertEquals(
    salesBookingSuburbFromContact({}, {
      name: "Pat Smith, Canning Vale WA 6155",
    }),
    "Canning Vale",
  );
  assertEquals(
    salesBookingSuburbFromContact({}, {
      customFields: [{ id: "cf-uuid", fieldValue: "Patio" }],
    }),
    SALES_BOOKING_NOT_GIVEN,
  );
});

Deno.test("search rows pick up city and tags from a later contact read", async () => {
  let requested: string[] = [];
  const payload = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [
            opportunity({
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: { id: "contact-1", name: "Pat" },
            }),
          ],
          stages: { [NITHIN_SCOPE_STAGE]: "Needs Scope / Quote" },
          exhausted: true,
          pages_scanned: 1,
          total: 1,
          reason: null,
        }),
      readContacts: (ids) => {
        requested = ids;
        return Promise.resolve({
          "contact-1": {
            city: "Queens Park",
            tags: ["northside patios"],
          },
        });
      },
    }),
    { resource: "nithin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(requested, ["contact-1"]);
  assertEquals(payload.cases[0].suburb, "Queens Park");
  assertEquals(payload.cases[0].job_type, "patio");
  assertEquals(payload.cases[0].tags, ["northside patios"]);
  assertEquals(
    applySalesBookingContactFact(
      { id: "opp-1", contact: { id: "c1" } },
      { city: "Fremantle", tags: ["sw fencing"] },
    ).contact,
    { id: "c1", city: "Fremantle", tags: ["sw fencing"] },
  );
});

Deno.test("job site fills suburb only when GHL city and address are empty", async () => {
  let asked = {
    opportunityIds: [] as string[],
    contactIds: [] as string[],
  };
  const payload = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [
            opportunity({
              id: "opp-empty",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: { id: "c-empty", name: "Pat" },
            }),
            opportunity({
              id: "opp-city",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: { id: "c-city", name: "Sam", city: "Fremantle" },
            }),
          ],
          stages: { [NITHIN_SCOPE_STAGE]: "Needs Scope / Quote" },
          exhausted: true,
          pages_scanned: 1,
          total: 2,
          reason: null,
        }),
      readJobSites: (ids) => {
        asked = ids;
        return Promise.resolve({
          "opp-empty": { suburb: "Balcatta" },
          "opp-city": { suburb: "Kinross" },
        });
      },
    }),
    { resource: "nithin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(asked.opportunityIds.sort(), ["opp-city", "opp-empty"]);
  assertEquals(
    payload.cases.find((row) => row.id === "opp-empty")?.suburb,
    "Balcatta",
  );
  assertEquals(
    payload.cases.find((row) => row.id === "opp-city")?.suburb,
    "Fremantle",
  );
});

Deno.test("live week paints given suburbs and job types from evidence, else not given", async () => {
  const patio = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [
            opportunity({
              id: "opp-city",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: {
                id: "c-city",
                name: "Pat",
                city: "Mosman Park",
                tags: ["northside patios"],
              },
            }),
            opportunity({
              id: "opp-address",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: {
                id: "c-address",
                name: "Sam",
                address1: "9 Reef Rd, Hillarys WA 6025",
                tags: ["northside patios"],
              },
            }),
            opportunity({
              id: "opp-job-site",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: { id: "c-job", name: "Kim" },
            }),
            opportunity({
              id: "opp-street",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: { id: "c-street", name: "Lee", city: "8 ison court" },
            }),
            opportunity({
              id: "opp-empty",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: { id: "c-empty", name: "Jo" },
            }),
            opportunity({
              id: "opp-lane",
              pipelineStageId: NITHIN_SCOPE_STAGE,
              contact: {
                id: "c-lane",
                name: "Alex",
                city: "Fremantle",
                tags: ["stratco"],
              },
            }),
          ],
          stages: { [NITHIN_SCOPE_STAGE]: "Needs Scope / Quote" },
          exhausted: true,
          pages_scanned: 1,
          total: 6,
          reason: null,
        }),
      readJobSites: () =>
        Promise.resolve({
          "opp-job-site": { suburb: "Balcatta" },
        }),
    }),
    { resource: "nithin", week_start: WEEK, include_thread_facts: false },
  );
  const patioById = Object.fromEntries(
    patio.cases.map((row) => [row.id, row]),
  );
  assertEquals(patioById["opp-city"]?.suburb, "Mosman Park");
  assertEquals(patioById["opp-city"]?.job_type, "patio");
  assertEquals(patioById["opp-address"]?.suburb, "Hillarys");
  assertEquals(patioById["opp-address"]?.job_type, "patio");
  assertEquals(patioById["opp-job-site"]?.suburb, "Balcatta");
  assertEquals(patioById["opp-job-site"]?.job_type, "patio");
  assertEquals(patioById["opp-street"]?.suburb, SALES_BOOKING_NOT_GIVEN);
  assertEquals(patioById["opp-empty"]?.suburb, SALES_BOOKING_NOT_GIVEN);
  assertEquals(patioById["opp-lane"]?.suburb, "Fremantle");
  assertEquals(patioById["opp-lane"]?.job_type, "patio");
  assertEquals(patio.send_hold, true);
  assertEquals(
    patio.cases.some((row) =>
      row.suburb === "Suburb unknown" || row.job_type === "No job data yet"
    ),
    false,
  );

  const fencing = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [
            opportunity({
              id: "opp-fence-tag",
              pipelineStageId: MARNIN_SCOPE_STAGE,
              contact: {
                id: "c-ft",
                name: "Pat",
                city: "Midland",
                tags: ["sw fencing"],
              },
            }),
            opportunity({
              id: "opp-fence-empty",
              pipelineStageId: MARNIN_SCOPE_STAGE,
              contact: { id: "c-fe", name: "Sam", tags: ["stratco"] },
            }),
          ],
          stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
          exhausted: true,
          pages_scanned: 1,
          total: 2,
          reason: null,
        }),
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(
    fencing.cases.find((row) => row.id === "opp-fence-tag")?.suburb,
    "Midland",
  );
  assertEquals(
    fencing.cases.find((row) => row.id === "opp-fence-tag")?.job_type,
    "fencing",
  );
  assertEquals(
    fencing.cases.find((row) => row.id === "opp-fence-empty")?.suburb,
    SALES_BOOKING_NOT_GIVEN,
  );
  assertEquals(
    fencing.cases.find((row) => row.id === "opp-fence-empty")?.job_type,
    "fencing",
  );

  assertEquals(
    salesBookingJobTypeFromOpportunity({}, { tags: ["northside patios"] }),
    "patio",
  );
  assertEquals(
    salesBookingJobTypeFromOpportunity({}, { tags: ["stratco"] }),
    SALES_BOOKING_NOT_GIVEN,
  );
});

Deno.test("live job-site read maps jobs rows by opportunity and contact id", async () => {
  const filters: Array<{ column: string; values: string[] }> = [];
  const client = {
    from(table: string) {
      assertEquals(table, "jobs");
      const self = {
        select(columns: string) {
          assertEquals(
            columns,
            "ghl_opportunity_id, ghl_contact_id, site_suburb, site_address",
          );
          return self;
        },
        in(column: string, values: string[]) {
          filters.push({ column, values: [...values] });
          const rows = column === "ghl_opportunity_id"
            ? [{
              ghl_opportunity_id: "opp-1",
              ghl_contact_id: "c-1",
              site_suburb: "Balcatta",
              site_address: "6 Moorby Pl",
            }]
            : [];
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return self;
    },
  };
  const facts = await createSalesBookingReadDependencies(client).readJobSites!({
    opportunityIds: ["opp-1"],
    contactIds: ["c-1"],
  });
  assertEquals(filters.map((row) => row.column).sort(), [
    "ghl_contact_id",
    "ghl_opportunity_id",
  ]);
  assertEquals(facts["opp-1"]?.suburb, "Balcatta");
  assertEquals(facts["c-1"]?.suburb, "Balcatta");
});

Deno.test("cached thread facts are served; stale activity is refreshed newest first", async () => {
  const persisted: Record<string, SalesBookingCachedThreadFact>[] = [];
  let liveReads = 0;
  const payload = await salesBookingRead(
    deps({
      loadThreadFactsCache: () => Promise.resolve({ "opp-1": cachedFact() }),
      persistThreadFactsCache: (_resource, facts) => {
        persisted.push(facts);
        return Promise.resolve();
      },
      readThread: () => {
        liveReads++;
        return Promise.resolve([] as SalesBookingMessage[]);
      },
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(liveReads, 0);
  assertEquals(payload.coverage.threads_cached, 1);
  assertEquals(payload.coverage.threads_fresh, 0);
  assertEquals(payload.thread_facts["opp-1"].classification, "follow_up_due");
  assertEquals(persisted.length, 0);

  liveReads = 0;
  persisted.length = 0;
  const stale = await salesBookingRead(
    deps({
      loadThreadFactsCache: () =>
        Promise.resolve({
          "opp-1": cachedFact({ read_at: "2026-09-14T00:00:00.000Z" }),
        }),
      persistThreadFactsCache: (_resource, facts) => {
        persisted.push(facts);
        return Promise.resolve();
      },
      readThread: () => {
        liveReads++;
        return Promise.resolve([] as SalesBookingMessage[]);
      },
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(liveReads, 1);
  assertEquals(stale.coverage.threads_fresh, 1);
  assertEquals(stale.coverage.threads_cached, 0);
  assertEquals(persisted.length, 1);
  assertEquals(
    salesBookingThreadFactIsFresh({
      cachedReadAt: "2026-09-16T01:00:00.000Z",
      lastActivityAt: "2026-09-15T01:00:00.000Z",
      nowMs: NOW.getTime(),
    }),
    true,
  );
  assertEquals(
    salesBookingThreadFactIsFresh({
      cachedReadAt: "2026-09-15T00:00:00.000Z",
      lastActivityAt: "2026-09-16T03:00:00.000Z",
      nowMs: NOW.getTime(),
    }),
    false,
  );
});

Deno.test("GHL 429 retries at most twice per call then counts remaining failures", async () => {
  assertEquals(salesBookingGhl429DelayMs(1, () => 0), 200);
  assertEquals(salesBookingGhl429DelayMs(2, () => 0), 400);
  assertEquals(salesBookingGhl429DelayMs(3, () => 0), 800);
  const sleeps: number[] = [];
  let attempts = 0;
  const value = await withSalesBookingGhl429Retry(() => {
    attempts++;
    if (attempts < 3) {
      const error = new Error("GHL 429: Too Many Requests");
      (error as { status?: number }).status = 429;
      return Promise.reject(error);
    }
    return Promise.resolve("ok");
  }, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  assertEquals(value, "ok");
  assertEquals(attempts, 3);
  assertEquals(sleeps, [200, 400]);

  let stormed = 0;
  await assertRejects(() =>
    withSalesBookingGhl429Retry(() => {
      stormed++;
      const error = new Error("GHL 429: Too Many Requests");
      (error as { status?: number }).status = 429;
      return Promise.reject(error);
    }, {
      tries: 99,
      sleep: () => Promise.resolve(),
      random: () => 0,
    })
  );
  assertEquals(stormed, 3);

  const nowMs = 0;
  let lateAttempts = 0;
  await assertRejects(() =>
    withSalesBookingGhl429Retry(() => {
      lateAttempts++;
      const error = new Error("GHL 429: Too Many Requests");
      (error as { status?: number }).status = 429;
      return Promise.reject(error);
    }, {
      now: () => new Date(nowMs),
      deadlineMs: 100,
      sleep: () => Promise.resolve(),
      random: () => 0,
    })
  );
  assertEquals(lateAttempts, 1);

  const payload = await salesBookingRead(
    deps({
      loadThreadFactsCache: () => Promise.resolve({ "opp-1": cachedFact() }),
      readThread: () => {
        const error = new Error("GHL 429: Too Many Requests");
        (error as { status?: number }).status = 429;
        return Promise.reject(error);
      },
    }),
    { resource: "marnin", week_start: WEEK, force_refresh: true },
  );
  assertEquals(payload.coverage.remaining_429_count, 1);
  assertEquals(payload.thread_facts["opp-1"].classification, "follow_up_due");
  assertEquals(payload.coverage.threads_cached, 1);
});

Deno.test("Nithin maps by recorded email when that address is on the roster", async () => {
  assertEquals(SALES_BOOKING_GHL_USERS.nithin.ghl_user_id, null);
  assertEquals(
    confirmSalesBookingGhlUser({
      users: GHL_USERS_BODY.users,
      email: SALES_BOOKING_GHL_USERS.nithin.email,
      nameMatch: "nithin",
    }),
    {
      id: "ghl_user_nithin",
      reason: null,
      match: "email",
      ghl_email: SALES_BOOKING_GHL_USERS.nithin.email,
    },
  );
  const scan = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: GHL_USERS_BODY,
      events: { events: [] },
    }),
    locationId: "loc",
    resourceId: "nithin",
    scoperUserId: SALES_BOOKING_RESOURCES.nithin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(scan.read_ok, true);
  assertEquals(scan.reason, null);
  assertEquals(scan.mapped_by, "email");
  assertEquals(scan.ghl_user_id, "ghl_user_nithin");
  assertEquals(scan.calendar_email, SALES_BOOKING_GHL_USERS.nithin.email);
  const payload = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(scan) }),
    { resource: "nithin", week_start: WEEK },
  );
  assertEquals(payload.diary_read.reason, null);
  assertEquals(payload.diary_read.mapped_by, "email");
  assertEquals(payload.diary_read.ghl_user_id, "ghl_user_nithin");
  assertEquals(
    payload.diary_read.calendar_email,
    SALES_BOOKING_GHL_USERS.nithin.email,
  );
});

Deno.test("Nithin maps by Outlook roster alias when the work address is absent", async () => {
  const users = [{
    id: "ERAycY7r6KZ8OA66WQCy",
    email: "nithinsilas@outlook.com",
    name: "Nithin Silas",
    firstName: "Nithin",
  }];
  assertEquals(
    confirmSalesBookingGhlUser({
      users,
      email: SALES_BOOKING_GHL_USERS.nithin.email,
      rosterEmails: SALES_BOOKING_GHL_USERS.nithin.roster_emails,
      nameMatch: "nithin",
    }),
    {
      id: "ERAycY7r6KZ8OA66WQCy",
      reason: null,
      match: "email",
      ghl_email: "nithinsilas@outlook.com",
    },
  );
  const scan = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: { users },
      events: { events: [] },
    }),
    locationId: "loc",
    resourceId: "nithin",
    scoperUserId: SALES_BOOKING_RESOURCES.nithin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(scan.read_ok, true);
  assertEquals(scan.reason, null);
  assertEquals(scan.mapped_by, "email");
  assertEquals(scan.ghl_user_id, "ERAycY7r6KZ8OA66WQCy");
  assertEquals(scan.calendar_email, "nithinsilas@outlook.com");
});

Deno.test("Nithin maps by unique GHL name when the recorded email is absent", async () => {
  const users = [
    {
      id: "ghl_nithin_live",
      email: "nithin.p@secureworkswa.com.au",
      name: "Nithin Patel",
      firstName: "Nithin",
    },
    {
      id: "ghl_user_marnin",
      email: SALES_BOOKING_GHL_USERS.marnin.email,
      name: "Marnin",
      firstName: "Marnin",
    },
  ];
  assertEquals(
    confirmSalesBookingGhlUser({
      users,
      email: SALES_BOOKING_GHL_USERS.nithin.email,
      nameMatch: "nithin",
    }),
    {
      id: "ghl_nithin_live",
      reason: null,
      match: "name",
      ghl_email: "nithin.p@secureworkswa.com.au",
    },
  );
  const scan = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: { users },
      events: { events: [] },
    }),
    locationId: "loc",
    resourceId: "nithin",
    scoperUserId: SALES_BOOKING_RESOURCES.nithin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(scan.read_ok, true);
  assertEquals(scan.reason, "ghl_user_mapped_by_name");
  assertEquals(scan.mapped_by, "name");
  assertEquals(scan.ghl_user_id, "ghl_nithin_live");
  assertEquals(scan.calendar_email, "nithin.p@secureworkswa.com.au");
  const payload = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(scan) }),
    { resource: "nithin", week_start: WEEK },
  );
  assertEquals(payload.diary_read.reason, "ghl_user_mapped_by_name");
  assertEquals(payload.diary_read.mapped_by, "name");
  assertEquals(payload.diary_read.ghl_user_id, "ghl_nithin_live");
  assertEquals(
    payload.diary_read.calendar_email,
    "nithin.p@secureworkswa.com.au",
  );
});

Deno.test("zero or several Nithin name matches stay ghl_user_unmapped", async () => {
  const none = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: {
        users: [{
          id: "ghl_other",
          email: "sam@secureworkswa.com.au",
          name: "Sam",
          firstName: "Sam",
        }],
      },
    }),
    locationId: "loc",
    resourceId: "nithin",
    scoperUserId: SALES_BOOKING_RESOURCES.nithin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(none.read_ok, false);
  assertEquals(none.reason, "ghl_user_unmapped");
  assertEquals(none.mapped_by, null);
  assertEquals(none.ghl_user_id, null);
  assertEquals(none.calendar_email, SALES_BOOKING_GHL_USERS.nithin.email);

  const several = await readSalesBookingGhlDiary({
    ghlGet: ghlDiaryGet({
      users: {
        users: [
          {
            id: "ghl_nithin_a",
            email: "nithin.a@secureworkswa.com.au",
            name: "Nithin A",
            firstName: "Nithin",
          },
          {
            id: "ghl_nithin_b",
            email: "nithin.b@secureworkswa.com.au",
            name: "Nithin B",
            firstName: "Nithin",
          },
        ],
      },
    }),
    locationId: "loc",
    resourceId: "nithin",
    scoperUserId: SALES_BOOKING_RESOURCES.nithin.scoper_user_id,
    since: "2026-09-14T00:00:00+08:00",
    untilExclusive: "2026-09-21T00:00:00+08:00",
  });
  assertEquals(several.read_ok, false);
  assertEquals(several.reason, "ghl_user_unmapped");
  assertEquals(several.mapped_by, null);
  assertEquals(several.ghl_user_id, null);
  assertEquals(several.calendar_email, SALES_BOOKING_GHL_USERS.nithin.email);
});

function threadFactsPackClient(
  seed: Array<{
    resource: string;
    week_start: string;
    kind: string;
    as_of: string;
    payload: Record<string, unknown>;
  }>,
  hooks?: {
    beforeDelete?: (
      store: Array<{
        id: string;
        resource: string;
        week_start: string;
        kind: string;
        as_of: string;
        payload: Record<string, unknown>;
      }>,
    ) => void;
    selectError?: { message: string };
  },
) {
  const store = seed.map((row) => ({
    id: crypto.randomUUID(),
    ...row,
  }));
  const writes: string[] = [];
  return {
    store,
    writes,
    from(table: string) {
      if (table !== "sales_booking_packs") {
        throw new Error(`unexpected table ${table}`);
      }
      const filters: Array<(row: (typeof store)[number]) => boolean> = [];
      let pending: (typeof store)[number] | null = null;
      let write: "upsert" | "delete" | null = null;
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      const run = () => {
        if (write === "upsert" && pending) {
          writes.push("upsert");
          store.push(pending);
          return { data: pending, error: null };
        }
        if (write === "delete") {
          writes.push("delete");
          hooks?.beforeDelete?.(store);
          const keep = store.filter((row) => !filters.every((fn) => fn(row)));
          store.splice(0, store.length, ...keep);
          return { data: null, error: null };
        }
        if (hooks?.selectError) {
          return { data: null, error: hooks.selectError };
        }
        let matched = store.filter((row) => filters.every((fn) => fn(row)));
        if (orderCol) {
          const col = orderCol as keyof (typeof store)[number];
          matched = matched.slice().sort((a, b) => {
            const av = String(a[col]);
            const bv = String(b[col]);
            return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (limitN != null) matched = matched.slice(0, limitN);
        return { data: matched, error: null };
      };
      const self = {
        select() {
          return self;
        },
        upsert(row: Record<string, unknown>) {
          write = "upsert";
          pending = {
            id: crypto.randomUUID(),
            resource: String(row.resource),
            week_start: String(row.week_start),
            kind: String(row.kind),
            as_of: String(row.as_of),
            payload:
              (row.payload && typeof row.payload === "object"
                ? row.payload
                : {}) as Record<string, unknown>,
          };
          return self;
        },
        delete() {
          write = "delete";
          return self;
        },
        eq(col: string, value: unknown) {
          filters.push((row) =>
            (row as Record<string, unknown>)[col] === value
          );
          return self;
        },
        neq(col: string, value: unknown) {
          filters.push((row) =>
            (row as Record<string, unknown>)[col] !== value
          );
          return self;
        },
        lt(col: string, value: unknown) {
          filters.push((row) =>
            String((row as Record<string, unknown>)[col]) < String(value)
          );
          return self;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return self;
        },
        limit(n: number) {
          limitN = n;
          return self;
        },
        maybeSingle() {
          const { data, error } = run();
          if (error) return Promise.resolve({ data: null, error });
          const row = Array.isArray(data) ? data[0] ?? null : data;
          return Promise.resolve({ data: row, error: null });
        },
        then(
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return self;
    },
  };
}

Deno.test("thread facts persist skips a write when the merged map equals the stored row", async () => {
  const facts = { "opp-1": cachedFact() };
  const client = threadFactsPackClient([{
    resource: "marnin",
    week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
    kind: SALES_BOOKING_THREAD_FACTS_KIND,
    as_of: "2026-09-16T01:00:00.000Z",
    payload: { facts },
  }]);
  await createSalesBookingReadDependencies(client).persistThreadFactsCache!(
    "marnin",
    facts,
  );
  assertEquals(client.writes, []);
  assertEquals(client.store.length, 1);
  assertEquals(client.store[0].as_of, "2026-09-16T01:00:00.000Z");
});

Deno.test("thread facts persist keeps one latest row per resource and week", async () => {
  const previous = { "opp-1": cachedFact() };
  const next = {
    "opp-1": cachedFact({
      classification: "waiting_reply",
      last_inbound_at: "2026-09-16T01:30:00.000Z",
      read_at: "2026-09-16T02:00:00.000Z",
    }),
  };
  const client = threadFactsPackClient([
    {
      resource: "marnin",
      week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
      kind: SALES_BOOKING_THREAD_FACTS_KIND,
      as_of: "2026-09-16T00:00:00.000Z",
      payload: { facts: previous },
    },
    {
      resource: "marnin",
      week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
      kind: SALES_BOOKING_THREAD_FACTS_KIND,
      as_of: "2026-09-16T01:00:00.000Z",
      payload: { facts: previous },
    },
  ]);
  await createSalesBookingReadDependencies(client).persistThreadFactsCache!(
    "marnin",
    next,
  );
  assertEquals(client.writes, ["upsert", "delete"]);
  assertEquals(client.store.length, 1);
  assertEquals(
    (client.store[0].payload as {
      facts?: { "opp-1"?: { classification?: string } };
    })
      .facts?.["opp-1"]?.classification,
    "waiting_reply",
  );
  assertEquals(client.store[0].kind, SALES_BOOKING_THREAD_FACTS_KIND);
  assertEquals(client.store[0].resource, "marnin");
  assertEquals(
    client.store[0].week_start,
    SALES_BOOKING_THREAD_FACTS_WEEK_START,
  );
});

Deno.test("thread facts persist prune keeps a newer concurrent as_of and drops older rows", async () => {
  const previous = { "opp-1": cachedFact() };
  const next = {
    "opp-1": cachedFact({
      classification: "waiting_reply",
      last_inbound_at: "2026-09-16T01:30:00.000Z",
      read_at: "2026-09-16T02:00:00.000Z",
    }),
  };
  const concurrentFacts = {
    "opp-1": cachedFact({
      classification: "waiting_reply",
      last_inbound_at: "2026-09-16T03:00:00.000Z",
      read_at: "2026-09-16T03:30:00.000Z",
    }),
  };
  let concurrentAsOf = "";
  const client = threadFactsPackClient(
    [
      {
        resource: "marnin",
        week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
        kind: SALES_BOOKING_THREAD_FACTS_KIND,
        as_of: "2026-09-16T00:00:00.000Z",
        payload: { facts: previous },
      },
    ],
    {
      beforeDelete(store) {
        const latest = store.reduce((a, b) => a.as_of > b.as_of ? a : b);
        concurrentAsOf = new Date(Date.parse(latest.as_of) + 1000)
          .toISOString();
        store.push({
          id: crypto.randomUUID(),
          resource: "marnin",
          week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
          kind: SALES_BOOKING_THREAD_FACTS_KIND,
          as_of: concurrentAsOf,
          payload: { facts: concurrentFacts },
        });
      },
    },
  );
  await createSalesBookingReadDependencies(client).persistThreadFactsCache!(
    "marnin",
    next,
  );
  assertEquals(client.writes, ["upsert", "delete"]);
  assertEquals(
    client.store.some((row) => row.as_of === "2026-09-16T00:00:00.000Z"),
    false,
  );
  assertEquals(
    client.store.some((row) => row.as_of === concurrentAsOf),
    true,
  );
  assertEquals(client.store.length, 2);
});

Deno.test("thread facts persist skips write and prune after a failed cache read", async () => {
  const stored = {
    "opp-1": cachedFact(),
    "opp-2": cachedFact({ case_id: "opp-2", contact_id: "contact-2" }),
  };
  const client = threadFactsPackClient(
    [{
      resource: "marnin",
      week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
      kind: SALES_BOOKING_THREAD_FACTS_KIND,
      as_of: "2026-09-16T01:00:00.000Z",
      payload: { facts: stored },
    }],
    { selectError: { message: "could not load thread_facts" } },
  );
  await createSalesBookingReadDependencies(client).persistThreadFactsCache!(
    "marnin",
    { "opp-1": cachedFact({ classification: "waiting_reply" }) },
  );
  assertEquals(client.writes, []);
  assertEquals(client.store.length, 1);
  assertEquals(
    (client.store[0].payload as { facts?: Record<string, unknown> }).facts,
    stored,
  );

  const persisted: Record<string, SalesBookingCachedThreadFact>[] = [];
  await salesBookingRead(
    deps({
      loadThreadFactsCache: () => Promise.reject(new Error("cache unread")),
      persistThreadFactsCache: (_resource, facts) => {
        persisted.push(facts);
        return Promise.resolve();
      },
    }),
    { resource: "marnin", week_start: WEEK, force_refresh: true },
  );
  assertEquals(persisted.length, 0);
});

Deno.test("thread facts persist writes a genuine empty store", async () => {
  const next = { "opp-1": cachedFact() };
  const client = threadFactsPackClient([]);
  await createSalesBookingReadDependencies(client).persistThreadFactsCache!(
    "marnin",
    next,
  );
  assertEquals(client.writes, ["upsert", "delete"]);
  assertEquals(client.store.length, 1);
  assertEquals(
    (client.store[0].payload as {
      facts?: { "opp-1"?: { classification?: string } };
    })
      .facts?.["opp-1"]?.classification,
    "follow_up_due",
  );
});

Deno.test("thread facts persist merges a limited refresh into the loaded map and prunes older rows", async () => {
  const existing = {
    "opp-1": cachedFact(),
    "opp-2": cachedFact({ case_id: "opp-2", contact_id: "contact-2" }),
  };
  const incoming = {
    "opp-1": cachedFact({
      classification: "waiting_reply",
      last_inbound_at: "2026-09-16T01:30:00.000Z",
      read_at: "2026-09-16T02:00:00.000Z",
    }),
  };
  const client = threadFactsPackClient([
    {
      resource: "marnin",
      week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
      kind: SALES_BOOKING_THREAD_FACTS_KIND,
      as_of: "2026-09-16T00:00:00.000Z",
      payload: { facts: existing },
    },
    {
      resource: "marnin",
      week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
      kind: SALES_BOOKING_THREAD_FACTS_KIND,
      as_of: "2026-09-16T01:00:00.000Z",
      payload: { facts: existing },
    },
  ]);
  await createSalesBookingReadDependencies(client).persistThreadFactsCache!(
    "marnin",
    incoming,
  );
  assertEquals(client.writes, ["upsert", "delete"]);
  assertEquals(client.store.length, 1);
  assertEquals(client.store[0].as_of > "2026-09-16T01:00:00.000Z", true);
  const facts = (client.store[0].payload as {
    facts?: Record<string, { classification?: string; case_id?: string }>;
  }).facts;
  assertEquals(facts?.["opp-1"]?.classification, "waiting_reply");
  assertEquals(facts?.["opp-2"]?.case_id, "opp-2");
});

Deno.test("whole-read budget exhaustion returns a well-formed response with gaps", async () => {
  let nowMs = NOW.getTime();
  let liveThreads = 0;
  const payload = await salesBookingRead(
    deps({
      now: () => new Date(nowMs),
      readOpportunities: () => {
        nowMs += SALES_BOOKING_READ_BUDGET_MS + 1;
        return Promise.resolve({
          opportunities: [opportunity()],
          stages: {},
          exhausted: false,
          pages_scanned: 2,
          total: 1012,
          reason: "time budget exhausted",
        });
      },
      readThread: () => {
        liveThreads++;
        return Promise.resolve([] as SalesBookingMessage[]);
      },
    }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.ok, true);
  assertEquals(payload.fixture, false);
  assertEquals(payload.send_hold, true);
  assertEquals(payload.cases.length, 1);
  assertEquals(payload.cases[0].id, "opp-1");
  assertEquals(liveThreads, 0);
  assertEquals(payload.coverage.full_population, false);
  assert(
    payload.coverage.gaps.some((g) => g.includes("time budget exhausted")),
  );
  assert(
    payload.coverage.gaps.some((g) => g.includes("not a completed empty book")),
  );
});

Deno.test("fresh roster is served from cache; stale roster is refreshed live", async () => {
  let liveReads = 0;
  const fresh = await salesBookingRead(
    deps({
      loadRosterCache: () => Promise.resolve(cachedRoster()),
      readOpportunities: () => {
        liveReads++;
        return Promise.resolve({
          opportunities: [opportunity({ id: "opp-live" })],
          stages: {},
          exhausted: true,
          pages_scanned: 1,
          total: 1,
          reason: null,
        });
      },
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(liveReads, 0);
  assertEquals(fresh.coverage.roster_source, "cache");
  assertEquals(fresh.coverage.roster_age_ms, 5 * 60_000);
  assertEquals(fresh.cases[0].id, "opp-1");
  assert(
    fresh.coverage.gaps.some((g) => g.includes("served from cache")),
  );

  liveReads = 0;
  const stale = await salesBookingRead(
    deps({
      loadRosterCache: () =>
        Promise.resolve(cachedRoster({
          read_at: "2026-09-16T01:40:00.000Z",
        })),
      persistRosterCache: () => Promise.resolve(),
      readOpportunities: () => {
        liveReads++;
        return Promise.resolve({
          opportunities: [opportunity({ id: "opp-live" })],
          stages: {},
          exhausted: true,
          pages_scanned: 4,
          total: 1,
          reason: null,
        });
      },
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(liveReads, 1);
  assertEquals(stale.coverage.roster_source, "live");
  assertEquals(stale.coverage.roster_age_ms, 0);
  assertEquals(stale.cases[0].id, "opp-live");
  assertEquals(
    salesBookingRosterIsFresh({
      cachedReadAt: "2026-09-16T01:55:00.000Z",
      nowMs: NOW.getTime(),
    }),
    true,
  );
  assertEquals(
    salesBookingRosterIsFresh({
      cachedReadAt: "2026-09-16T01:40:00.000Z",
      nowMs: NOW.getTime(),
    }),
    false,
  );
});

Deno.test("a 429 during live roster refresh falls back to the cached roster", async () => {
  const resolved = await resolveSalesBookingRoster({
    cached: cachedRoster(),
    nowMs: NOW.getTime(),
    forceRefresh: true,
    live: () =>
      Promise.resolve({
        opportunities: [],
        stages: {},
        exhausted: false,
        pages_scanned: 1,
        total: 1012,
        reason: "GHL 429: Too Many Requests",
        remaining_429_count: 1,
      }),
  });
  assertEquals(resolved.shouldPersist, false);
  assertEquals(resolved.scan.source, "cache");
  assertEquals(resolved.scan.opportunities[0]?.id, "opp-1");
  assertEquals(resolved.scan.remaining_429_count, 1);

  const payload = await salesBookingRead(
    deps({
      loadRosterCache: () => Promise.resolve(cachedRoster()),
      readOpportunities: () =>
        Promise.resolve({
          opportunities: [],
          stages: {},
          exhausted: false,
          pages_scanned: 1,
          total: 1012,
          reason: "GHL 429: Too Many Requests",
          remaining_429_count: 1,
        }),
    }),
    {
      resource: "marnin",
      week_start: WEEK,
      include_thread_facts: false,
      force_refresh: true,
    },
  );
  assertEquals(payload.ok, true);
  assertEquals(payload.coverage.roster_source, "cache");
  assertEquals(payload.cases.length, 1);
  assertEquals(payload.cases[0].id, "opp-1");
  assertEquals(payload.coverage.remaining_429_count >= 1, true);
  assert(
    payload.coverage.gaps.some((g) =>
      g.includes("served from cache after GHL 429")
    ),
  );
  assert(
    payload.coverage.gaps.some((g) =>
      g.includes("GHL 429 Too Many Requests remaining after retries")
    ),
  );
});

Deno.test("opportunity paging stops when the whole-read deadline is reached", async () => {
  let nowMs = NOW.getTime();
  let pages = 0;
  const scan = await readSalesBookingOpportunities({
    pipelineId: SALES_BOOKING_RESOURCES.marnin.pipeline_id,
    locationId: "loc",
    now: () => new Date(nowMs),
    deadlineMs: NOW.getTime() + 1,
    ghlGet: () => {
      pages++;
      nowMs += 10_000;
      return Promise.resolve({
        opportunities: Array.from({ length: 100 }, (_, i) => ({
          id: `opp-page-${pages}-${i}`,
          sort: [pages, `c-${i}`],
        })),
        meta: { total: 900, startAfter: pages, startAfterId: `c-99` },
      });
    },
  });
  assertEquals(pages, 1);
  assertEquals(scan.exhausted, false);
  assertEquals(scan.reason, "time budget exhausted");
  assertEquals(scan.opportunities.length, 100);
});

Deno.test("roster persist keeps one latest row per resource at the weekless sentinel", async () => {
  const next = cachedRoster({
    pages_scanned: 8,
    read_at: "2026-09-16T02:00:00.000Z",
  });
  const client = threadFactsPackClient([
    {
      resource: "marnin",
      week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
      kind: SALES_BOOKING_ROSTER_KIND,
      as_of: "2026-09-16T00:00:00.000Z",
      payload: { ...cachedRoster({ pages_scanned: 1 }) },
    },
    {
      resource: "marnin",
      week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
      kind: SALES_BOOKING_ROSTER_KIND,
      as_of: "2026-09-16T01:00:00.000Z",
      payload: { ...cachedRoster({ pages_scanned: 1 }) },
    },
  ]);
  await createSalesBookingReadDependencies(client).persistRosterCache!(
    "marnin",
    next,
  );
  assertEquals(client.writes, ["upsert", "delete"]);
  assertEquals(client.store.length, 1);
  assertEquals(client.store[0].kind, SALES_BOOKING_ROSTER_KIND);
  assertEquals(client.store[0].resource, "marnin");
  assertEquals(
    client.store[0].week_start,
    SALES_BOOKING_THREAD_FACTS_WEEK_START,
  );
  assertEquals(
    (client.store[0].payload as { pages_scanned?: number }).pages_scanned,
    8,
  );
});

Deno.test("roster persist skips a write when the stored roster equals the incoming scan", async () => {
  const roster = cachedRoster();
  const client = threadFactsPackClient([{
    resource: "marnin",
    week_start: SALES_BOOKING_THREAD_FACTS_WEEK_START,
    kind: SALES_BOOKING_ROSTER_KIND,
    as_of: "2026-09-16T01:00:00.000Z",
    payload: { ...roster },
  }]);
  await createSalesBookingReadDependencies(client).persistRosterCache!(
    "marnin",
    roster,
  );
  assertEquals(client.writes, []);
  assertEquals(client.store.length, 1);
});

Deno.test("a complete cached roster beats an incomplete live refresh for any reason", async () => {
  const complete = cachedRoster({
    opportunities: Array.from(
      { length: 3 },
      (_, i) => opportunity({ id: `opp-cache-${i}` }),
    ),
    pages_scanned: 11,
    total: 1012,
    exhausted: true,
    reason: null,
  });
  const incompleteLive = {
    opportunities: [opportunity({ id: "opp-live-200" })],
    stages: {},
    exhausted: false,
    pages_scanned: 2,
    total: 1012,
    reason: "time budget exhausted",
    remaining_429_count: 0,
  };
  const resolved = await resolveSalesBookingRoster({
    cached: complete,
    nowMs: NOW.getTime(),
    forceRefresh: true,
    live: () => Promise.resolve(incompleteLive),
  });
  assertEquals(resolved.shouldPersist, false);
  assertEquals(resolved.scan.source, "cache");
  assertEquals(resolved.scan.opportunities.length, 3);
  assertEquals(resolved.scan.opportunities[0]?.id, "opp-cache-0");
  assertEquals(resolved.scan.reason, "time budget exhausted");
  assertEquals(salesBookingRosterIsComplete(complete), true);
  assertEquals(salesBookingRosterIsComplete(resolved.scan), false);

  const payload = await salesBookingRead(
    deps({
      loadRosterCache: () => Promise.resolve(complete),
      persistRosterCache: () => {
        throw new Error("complete cache must not be replaced");
      },
      readOpportunities: () => Promise.resolve(incompleteLive),
    }),
    {
      resource: "marnin",
      week_start: WEEK,
      include_thread_facts: false,
      force_refresh: true,
    },
  );
  assertEquals(payload.coverage.roster_source, "cache");
  assertEquals(payload.coverage.full_population, true);
  assertEquals(payload.cases.length, 3);
  assertEquals(payload.cases[0].id, "opp-cache-0");
  assert(
    payload.coverage.gaps.some((g) => g.includes("time budget exhausted")),
  );
  assert(
    payload.coverage.gaps.some((g) => g.includes("served from cache")),
  );

  const pageError = await resolveSalesBookingRoster({
    cached: complete,
    nowMs: NOW.getTime(),
    forceRefresh: true,
    live: () =>
      Promise.resolve({
        ...incompleteLive,
        reason: "opportunity search failed",
        pages_scanned: 1,
      }),
  });
  assertEquals(pageError.shouldPersist, false);
  assertEquals(pageError.scan.source, "cache");
  assertEquals(pageError.scan.opportunities.length, 3);
  assertEquals(pageError.scan.reason, "opportunity search failed");
});

Deno.test("roster cache is one latest row per resource and ignores the door week", async () => {
  const persisted: Array<{ resource: string; week_start?: string }> = [];
  const loaded: string[] = [];
  const cache = cachedRoster();
  const thisWeek = await salesBookingRead(
    deps({
      loadRosterCache: (resourceId) => {
        loaded.push(resourceId);
        return Promise.resolve(cache);
      },
      persistRosterCache: (resourceId) => {
        persisted.push({ resource: resourceId });
        return Promise.resolve();
      },
      readOpportunities: () => {
        throw new Error("fresh complete roster must not live-refresh");
      },
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  const lastWeek = await salesBookingRead(
    deps({
      loadRosterCache: (resourceId) => {
        loaded.push(resourceId);
        return Promise.resolve(cache);
      },
      persistRosterCache: (resourceId) => {
        persisted.push({ resource: resourceId });
        return Promise.resolve();
      },
      readOpportunities: () => {
        throw new Error("fresh complete roster must not live-refresh");
      },
    }),
    {
      resource: "marnin",
      week_start: "2026-09-07",
      include_thread_facts: false,
    },
  );
  assertEquals(loaded, ["marnin", "marnin"]);
  assertEquals(persisted, []);
  assertEquals(thisWeek.coverage.roster_source, "cache");
  assertEquals(lastWeek.coverage.roster_source, "cache");
  assertEquals(thisWeek.week_start, WEEK);
  assertEquals(lastWeek.week_start, "2026-09-07");

  const client = threadFactsPackClient([{
    resource: "marnin",
    week_start: WEEK,
    kind: SALES_BOOKING_ROSTER_KIND,
    as_of: "2026-09-16T01:00:00.000Z",
    payload: { ...cachedRoster({ pages_scanned: 1 }) },
  }]);
  await createSalesBookingReadDependencies(client).persistRosterCache!(
    "marnin",
    cachedRoster({ pages_scanned: 11 }),
  );
  const loadedLive = await createSalesBookingReadDependencies(client)
    .loadRosterCache!("marnin");
  assertEquals(loadedLive?.pages_scanned, 11);
  assertEquals(
    client.store.some((row) =>
      row.kind === SALES_BOOKING_ROSTER_KIND &&
      row.week_start === SALES_BOOKING_THREAD_FACTS_WEEK_START
    ),
    true,
  );
  assertEquals(
    client.store.filter((row) =>
      row.kind === SALES_BOOKING_ROSTER_KIND &&
      row.week_start === SALES_BOOKING_THREAD_FACTS_WEEK_START
    ).length,
    1,
  );
});

Deno.test("an incomplete live roster is persisted and the next read resumes from its cursor", async () => {
  const pageOne = Array.from(
    { length: 2 },
    (_, i) => opportunity({ id: `opp-p1-${i}` }),
  );
  const pageTwo = Array.from(
    { length: 2 },
    (_, i) => opportunity({ id: `opp-p2-${i}` }),
  );
  const first = await resolveSalesBookingRoster({
    cached: null,
    nowMs: NOW.getTime(),
    live: () =>
      Promise.resolve({
        opportunities: pageOne,
        stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
        exhausted: false,
        pages_scanned: 2,
        total: 4,
        reason: "time budget exhausted",
        start_after: 2,
        start_after_id: "c-99",
      }),
  });
  assertEquals(first.shouldPersist, true);
  assertEquals(first.scan.exhausted, false);
  assertEquals(first.scan.opportunities.map((row) => row.id), [
    "opp-p1-0",
    "opp-p1-1",
  ]);
  assertEquals(first.scan.start_after, 2);
  assertEquals(first.scan.start_after_id, "c-99");
  assertEquals(salesBookingRosterIsComplete(first.scan), false);

  const stored = cachedRosterFromScan(first.scan, NOW.toISOString());
  const resumes: Array<{
    startAfter?: string | number | null;
    startAfterId?: string | null;
  }> = [];
  const second = await resolveSalesBookingRoster({
    cached: stored,
    nowMs: NOW.getTime(),
    live: (resume) => {
      resumes.push(resume ?? {});
      return Promise.resolve({
        opportunities: pageTwo,
        stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
        exhausted: true,
        pages_scanned: 2,
        total: 4,
        reason: null,
        start_after: 4,
        start_after_id: "c-199",
      });
    },
  });
  assertEquals(resumes, [{ startAfter: 2, startAfterId: "c-99" }]);
  assertEquals(second.shouldPersist, true);
  assertEquals(second.scan.exhausted, true);
  assertEquals(second.scan.reason, null);
  assertEquals(second.scan.opportunities.map((row) => row.id), [
    "opp-p1-0",
    "opp-p1-1",
    "opp-p2-0",
    "opp-p2-1",
  ]);
  assertEquals(second.scan.pages_scanned, 4);
  assertEquals(second.scan.start_after, null);
  assertEquals(salesBookingRosterIsComplete(second.scan), true);

  const persisted: SalesBookingCachedRoster[] = [];
  const incompleteCache = cachedRoster({
    opportunities: pageOne,
    exhausted: false,
    reason: "time budget exhausted",
    pages_scanned: 2,
    total: 4,
    start_after: 2,
    start_after_id: "c-99",
    read_at: NOW.toISOString(),
  });
  const payload = await salesBookingRead(
    deps({
      loadRosterCache: () => Promise.resolve(incompleteCache),
      persistRosterCache: (_resourceId, roster) => {
        persisted.push(roster);
        return Promise.resolve();
      },
      readOpportunities: (args) => {
        assertEquals(args.startAfter, 2);
        assertEquals(args.startAfterId, "c-99");
        return Promise.resolve({
          opportunities: pageTwo,
          stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
          exhausted: true,
          pages_scanned: 2,
          total: 4,
          reason: null,
        });
      },
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(payload.coverage.roster_source, "live");
  assertEquals(payload.coverage.full_population, true);
  assertEquals(payload.cases.map((row) => row.id), [
    "opp-p1-0",
    "opp-p1-1",
    "opp-p2-0",
    "opp-p2-1",
  ]);
  assertEquals(persisted.length, 1);
  assertEquals(persisted[0].exhausted, true);
  assertEquals(persisted[0].reason, null);
  assertEquals(persisted[0].start_after, null);

  const coldPersisted: SalesBookingCachedRoster[] = [];
  const cold = await salesBookingRead(
    deps({
      persistRosterCache: (_resourceId, roster) => {
        coldPersisted.push(roster);
        return Promise.resolve();
      },
      readOpportunities: () =>
        Promise.resolve({
          opportunities: pageOne,
          stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
          exhausted: false,
          pages_scanned: 2,
          total: 4,
          reason: "time budget exhausted",
          start_after: 2,
          start_after_id: "c-99",
        }),
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(cold.coverage.full_population, false);
  assertEquals(cold.cases.map((row) => row.id), ["opp-p1-0", "opp-p1-1"]);
  assert(
    cold.coverage.gaps.some((g) => g.includes("not a completed empty book")),
  );
  assertEquals(coldPersisted.length, 1);
  assertEquals(coldPersisted[0].exhausted, false);
  assertEquals(coldPersisted[0].start_after, 2);
  assertEquals(coldPersisted[0].start_after_id, "c-99");
});

Deno.test("force_refresh on an incomplete roster resumes from its cursor and merges", async () => {
  const cached400 = Array.from(
    { length: 400 },
    (_, i) => opportunity({ id: `opp-cache-${i}` }),
  );
  const live200 = Array.from(
    { length: 200 },
    (_, i) => opportunity({ id: `opp-live-${i}` }),
  );
  const incomplete = cachedRoster({
    opportunities: cached400,
    exhausted: false,
    reason: "time budget exhausted",
    pages_scanned: 4,
    total: 1012,
    start_after: 4,
    start_after_id: "c-399",
    read_at: NOW.toISOString(),
  });
  const resumes: Array<{
    startAfter?: string | number | null;
    startAfterId?: string | null;
  }> = [];
  const resolved = await resolveSalesBookingRoster({
    cached: incomplete,
    nowMs: NOW.getTime(),
    forceRefresh: true,
    live: (resume) => {
      resumes.push(resume ?? {});
      return Promise.resolve({
        opportunities: live200,
        stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
        exhausted: false,
        pages_scanned: 2,
        total: 1012,
        reason: "time budget exhausted",
        start_after: 6,
        start_after_id: "c-599",
      });
    },
  });
  assertEquals(resumes, [{ startAfter: 4, startAfterId: "c-399" }]);
  assertEquals(resolved.shouldPersist, true);
  assertEquals(resolved.scan.opportunities.length, 600);
  assertEquals(resolved.scan.opportunities[0]?.id, "opp-cache-0");
  assertEquals(resolved.scan.opportunities[399]?.id, "opp-cache-399");
  assertEquals(resolved.scan.opportunities[400]?.id, "opp-live-0");
  assertEquals(resolved.scan.opportunities[599]?.id, "opp-live-199");
  assertEquals(resolved.scan.start_after, 6);
  assertEquals(resolved.scan.start_after_id, "c-599");
  assertEquals(resolved.scan.exhausted, false);
  assertEquals(salesBookingRosterIsComplete(resolved.scan), false);

  const persisted: SalesBookingCachedRoster[] = [];
  const payload = await salesBookingRead(
    deps({
      loadRosterCache: () => Promise.resolve(incomplete),
      persistRosterCache: (_resourceId, roster) => {
        persisted.push(roster);
        return Promise.resolve();
      },
      readOpportunities: (args) => {
        assertEquals(args.startAfter, 4);
        assertEquals(args.startAfterId, "c-399");
        return Promise.resolve({
          opportunities: live200,
          stages: { [MARNIN_SCOPE_STAGE]: "New Lead" },
          exhausted: false,
          pages_scanned: 2,
          total: 1012,
          reason: "time budget exhausted",
          start_after: 6,
          start_after_id: "c-599",
        });
      },
    }),
    {
      resource: "marnin",
      week_start: WEEK,
      include_thread_facts: false,
      force_refresh: true,
    },
  );
  assertEquals(payload.coverage.full_population, false);
  assertEquals(payload.cases.length, 600);
  assertEquals(persisted.length, 1);
  assertEquals(persisted[0].opportunities.length, 600);
  assertEquals(persisted[0].start_after, 6);
  assertEquals(persisted[0].start_after_id, "c-599");
  assertEquals(persisted[0].exhausted, false);
});

Deno.test("opportunity paging resumes from the stored cursor inside the deadline", async () => {
  const paths: string[] = [];
  let nowMs = NOW.getTime();
  const scan = await readSalesBookingOpportunities({
    pipelineId: SALES_BOOKING_RESOURCES.marnin.pipeline_id,
    locationId: "loc",
    now: () => new Date(nowMs),
    deadlineMs: NOW.getTime() + 15_000,
    startAfter: 2,
    startAfterId: "c-99",
    ghlGet: (path) => {
      paths.push(path);
      nowMs += 20_000;
      return Promise.resolve({
        opportunities: Array.from({ length: 100 }, (_, i) => ({
          id: `opp-resume-${i}`,
          sort: [3, `c-${i}`],
        })),
        meta: { total: 900, startAfter: 3, startAfterId: "c-199" },
      });
    },
  });
  assertEquals(paths.length, 1);
  assert(
    paths[0].includes("startAfter=2") && paths[0].includes("startAfterId=c-99"),
  );
  assertEquals(scan.exhausted, false);
  assertEquals(scan.reason, "time budget exhausted");
  assertEquals(scan.opportunities[0]?.id, "opp-resume-0");
  assertEquals(scan.start_after, 3);
  assertEquals(scan.start_after_id, "c-199");
});
