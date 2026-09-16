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
 * What these do NOT prove: that GHL or Microsoft Graph accept the live request
 * shapes, or that production credentials exist. Those need a live read.
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
  applyThreadFactsToCase,
  assembleSalesBookingRead,
  defaultPerthWeekStart,
  deriveSalesBookingThreadFacts,
  isPhoneLikeName,
  isSalesBookingTemplateBody,
  perthGraphInstant,
  perthWeekWindow,
  projectSalesBookingCase,
  projectSalesBookingDiaryEntry,
  SALES_BOOKING_API_VERSION,
  SALES_BOOKING_CAPTAIN_DEFAULTS,
  SALES_BOOKING_RESOURCES,
  salesBookingRead,
  SalesBookingRequestError,
  type SalesBookingDiaryScan,
  type SalesBookingMessage,
  type SalesBookingReadDependencies,
  unreadSalesBookingThreadFacts,
} from "./sales_booking_read.ts";

const NOW = new Date("2026-09-16T02:00:00.000Z"); // Wed 10:00 Perth
const WEEK = "2026-09-14"; // Monday

// ── Fixtures ────────────────────────────────────────────────

function opportunity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "opp-1",
    name: "Jane Smith",
    pipelineStageId: "stage-a",
    status: "open",
    updatedAt: "2026-09-15T01:00:00.000Z",
    contact: { id: "contact-1", name: "Jane Smith", city: "Canning Vale", tags: ["stratco"] },
    ...overrides,
  };
}

function graphEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-1",
    subject: "Scope visit - Beckenham",
    start: { dateTime: "2026-09-15T10:00:00.0000000", timeZone: "Australia/Perth" },
    end: { dateTime: "2026-09-15T11:30:00.0000000", timeZone: "Australia/Perth" },
    location: { displayName: "12 Example St" },
    isAllDay: false,
    showAs: "busy",
    sensitivity: "normal",
    ...overrides,
  };
}

/** A dependency set whose every member is a reader; no write seam exists. */
function deps(overrides: Partial<SalesBookingReadDependencies> = {}): SalesBookingReadDependencies {
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
        entries: [projectSalesBookingDiaryEntry(graphEvent())!],
        malformed_dropped: 0,
        calendar_email: "marnin@secureworkswa.com.au",
        scoper_user_id: SALES_BOOKING_RESOURCES.marnin.scoper_user_id,
      }),
    readThread: () => Promise.resolve([] as SalesBookingMessage[]),
    now: () => NOW,
    ...overrides,
  };
}

const UNREAD_DIARY: SalesBookingDiaryScan = {
  read_ok: false,
  reason: "calendar_http_403",
  entries: [],
  malformed_dropped: 0,
  calendar_email: "marnin@secureworkswa.com.au",
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
  assertEquals(defaultPerthWeekStart(new Date("2026-09-13T17:30:00Z")), "2026-09-14");
  assertEquals(defaultPerthWeekStart(new Date("2026-09-13T15:00:00Z")), "2026-09-07");
  assertEquals(defaultPerthWeekStart(NOW), "2026-09-14");
});

// ── Template markers ────────────────────────────────────────

Deno.test("template markers match case-insensitively across line wrapping", () => {
  assert(isSalesBookingTemplateBody("Thanks for reaching out to SecureWorks!"));
  assert(isSalesBookingTemplateBody("Sorry we missed your\n  call, we will ring back."));
  assert(!isSalesBookingTemplateBody("Hi Jane, can I come Tuesday between 10 and 11:30?"));
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
    { type: "TYPE_SMS", direction: "inbound", body: "keen", timestamp: "2026-09-14T01:00:00.000Z" },
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
    deriveSalesBookingThreadFacts({ caseId: "c", contactId: "x", messages: [], nowMs: NOW.getTime() })
      .classification,
    "ready_to_contact",
  );
  const facts = deriveSalesBookingThreadFacts({
    caseId: "c",
    contactId: "x",
    messages: [
      { type: "TYPE_ACTIVITY_OPPORTUNITY", direction: "outbound", body: "stage moved", timestamp: "2026-09-16T01:00:00.000Z" },
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
      { type: "TYPE_SMS", body: "ours", timestamp: "2026-09-16T00:00:00.000Z", userId: "user-9" },
      { type: "TYPE_SMS", body: "theirs", timestamp: "2026-09-15T00:00:00.000Z" },
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

  const named = projectSalesBookingCase(opportunity(), "marnin", { "stage-a": "New Lead" })!;
  assertObjectMatch(named as unknown as Record<string, unknown>, {
    id: "opp-1",
    resource_id: "marnin",
    opportunity_id: "opp-1",
    contact_id: "contact-1",
    suburb: "Canning Vale",
    display_name: "Jane Smith",
    status: "needs_decision",
    status_source: "unread",
    stage_name: "New Lead",
  });
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

Deno.test("an unread thread never overwrites the case status", () => {
  const row = projectSalesBookingCase(opportunity(), "marnin")!;
  const unread = applyThreadFactsToCase(row, unreadSalesBookingThreadFacts("opp-1", "contact-1", "ghl_thread_unread: 502"));
  assertEquals(unread.status, "needs_decision");
  assertEquals(unread.status_source, "unread");

  const read = applyThreadFactsToCase(
    row,
    deriveSalesBookingThreadFacts({ caseId: "opp-1", contactId: "contact-1", messages: [], nowMs: NOW.getTime() }),
  );
  assertEquals(read.status, "ready_to_contact");
  assertEquals(read.status_source, "thread_facts");
});

// ── Diary ───────────────────────────────────────────────────

Deno.test("perthGraphInstant stamps the Perth offset on an offset-less Graph value", () => {
  assertEquals(perthGraphInstant("2026-09-15T10:00:00.0000000"), "2026-09-15T10:00:00+08:00");
  assertEquals(perthGraphInstant("2026-09-15T02:00:00Z"), "2026-09-15T02:00:00Z");
  assertEquals(perthGraphInstant("not a date"), null);
  assertEquals(perthGraphInstant(undefined), null);
});

Deno.test("diary kind comes from provider fields, never from subject text", () => {
  const busy = projectSalesBookingDiaryEntry(graphEvent())!;
  assertObjectMatch(busy as unknown as Record<string, unknown>, {
    event_id: "evt-1",
    start: "2026-09-15T10:00:00+08:00",
    end: "2026-09-15T11:30:00+08:00",
    title: "Scope visit - Beckenham",
    kind: "busy",
    source: "outlook_primary",
    blocks_capacity: true,
    title_withheld: false,
  });

  assertEquals(projectSalesBookingDiaryEntry(graphEvent({ showAs: "oof" }))!.kind, "leave");
  assertEquals(projectSalesBookingDiaryEntry(graphEvent({ showAs: "free" }))!.blocks_capacity, false);

  // A subject that merely SAYS leave is not a leave fact.
  const worded = projectSalesBookingDiaryEntry(graphEvent({ subject: "Annual leave chat" }))!;
  assertEquals(worded.kind, "busy");

  // A private entry is a block on the diary, without its subject or location.
  const priv = projectSalesBookingDiaryEntry(graphEvent({ sensitivity: "private" }))!;
  assertEquals(priv.kind, "personal");
  assertEquals(priv.title, null);
  assertEquals(priv.location, null);
  assertEquals(priv.title_withheld, true);

  assertEquals(projectSalesBookingDiaryEntry({ id: "x" }), null);
  assertEquals(projectSalesBookingDiaryEntry(graphEvent({ id: "" })), null);
});

// ── Assembly / coverage honesty ─────────────────────────────

Deno.test("response keeps the reference shape the Sales Booking view consumes", async () => {
  const payload = await salesBookingRead(deps(), { resource: "marnin", week_start: WEEK });
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

Deno.test("the shipped view's own keys are served from the same read", async () => {
  // ops-sales-booking.js reads `data.events` for the week grid and
  // `data.resource.calendar.leave` for the leave caveat. Both must come off
  // THIS response, or the shipped view renders "No provider events".
  const payload = await salesBookingRead(deps(), { resource: "marnin", week_start: WEEK });
  assertEquals(payload.events, payload.diary);
  assertEquals(payload.resource.calendar.leave, "not_read");
  assertEquals(payload.resource.calendar.read_ok, true);
  assertEquals(payload.resource.calendar.email, "marnin@secureworkswa.com.au");

  const unread = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(UNREAD_DIARY) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(unread.events, []);
  assertEquals(unread.resource.calendar.read_ok, false);
  // The static profile is never mutated by publishing calendar provenance.
  assertEquals(
    (SALES_BOOKING_RESOURCES.marnin as unknown as Record<string, unknown>).calendar,
    undefined,
  );
});

Deno.test("FIXTURE: an unread calendar names the gap and never throws", async () => {
  const payload = await salesBookingRead(
    deps({ readDiary: () => Promise.resolve(UNREAD_DIARY) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.ok, true);
  assertEquals(payload.diary, []);
  assertEquals(payload.diary_read.read_ok, false);
  assertEquals(payload.diary_read.reason, "calendar_http_403");
  assertEquals(payload.coverage.diary_read_ok, false);
  // The cases side is untouched: a calendar fault is not a roster fault.
  assertEquals(payload.cases.length, 1);
  const gap = payload.coverage.gaps.find((g) => g.includes("calendar"))!;
  assertStringIncludes(gap, "calendar_http_403");
  // Unread coverage is never spare capacity.
  assertStringIncludes(gap, "not free capacity");
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
    threads: { facts: {}, attempted: 0, read_ok_count: 0, not_attempted: 0, budget_exhausted: false, enabled: true },
  });
  assertEquals(payload.coverage.full_population, false);
  assertEquals(payload.coverage.enumerated, 0);
  assertStringIncludes(payload.coverage.gaps[0], "not a completed empty book");
  assert(payload.coverage.gaps.some((g) => g.includes("page cap 20 reached")));
});

Deno.test("a failed thread read degrades only that case and is named in coverage", async () => {
  const payload = await salesBookingRead(
    deps({ readThread: () => Promise.reject(new Error("GHL 502: bad gateway")) }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(payload.ok, true);
  const facts = payload.thread_facts["opp-1"];
  assertEquals(facts.read_ok, false);
  assertStringIncludes(facts.reason!, "GHL 502");
  assertEquals(facts.classification, "unread");
  assertEquals(payload.cases[0].status, "needs_decision");
  assertEquals(payload.cases[0].status_source, "unread");
  assert(payload.coverage.gaps.some((g) => g.includes("thread read(s) failed")));
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
  assertEquals(payload.thread_facts["opp-1"].reason, "no_ghl_contact_on_opportunity");
  assertEquals(payload.thread_facts["opp-1"].read_ok, false);
});

Deno.test("thread_limit leaves the remainder unproved rather than unreported", async () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    opportunity({ id: `opp-${i}`, contact: { id: `contact-${i}`, name: `Lead ${i}` } }));
  const payload = await salesBookingRead(
    deps({
      readOpportunities: () =>
        Promise.resolve({ opportunities: many, stages: {}, exhausted: true, pages_scanned: 1, total: 5, reason: null }),
    }),
    { resource: "marnin", week_start: WEEK, thread_limit: 2 },
  );
  assertEquals(payload.cases.length, 5);
  assertEquals(Object.keys(payload.thread_facts).length, 2);
  assertEquals(payload.coverage.threads_read, 2);
  assert(payload.coverage.gaps.some((g) => g.includes("3 case(s) had no thread read")));
  // Unproved cases keep the reference default, not a clean-looking disposition.
  const unproved = payload.cases.filter((c) => c.status_source === "unread");
  assertEquals(unproved.length, 3);
});

Deno.test("include_thread_facts:false skips every thread read and says so", async () => {
  const payload = await salesBookingRead(
    deps({
      readThread: () => {
        throw new Error("readThread must not be called when thread facts are off");
      },
    }),
    { resource: "marnin", week_start: WEEK, include_thread_facts: false },
  );
  assertEquals(payload.thread_facts, {});
  assert(payload.coverage.gaps.some((g) => g.includes("Thread facts were not requested")));
});

// ── Request validation ──────────────────────────────────────

Deno.test("resource selects the lane's own pipeline and scoper; unknown refuses", async () => {
  const nithin = await salesBookingRead(deps(), { resource: "nithin", week_start: WEEK });
  assertEquals(nithin.resource.pipeline_id, "OGZLpPPVWVarN94HL6af");
  assertEquals(nithin.resource.lane, "patio");
  assertEquals(nithin.resource.sender_line, "774");

  const marnin = await salesBookingRead(deps(), { resource: "marnin", week_start: WEEK });
  assertEquals(marnin.resource.pipeline_id, "I9t8njpuR0Dm7B2NDcvI");
  assertEquals(marnin.resource.lane, "fencing");
  // Fencing and patio pipelines are never mixed.
  assert(marnin.resource.pipeline_id !== nithin.resource.pipeline_id);

  await assertRejects(
    () => salesBookingRead(deps(), { resource: "khairo", week_start: WEEK }),
    SalesBookingRequestError,
  );
  await assertRejects(
    () => salesBookingRead(deps(), { resource: "marnin", week_start: "2026-09-15" }),
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
    { resource: "marnin", week_start: WEEK, scoper_user_id: "11111111-2222-3333-4444-555555555555" },
  );
  assertEquals(seen, "11111111-2222-3333-4444-555555555555");
  // The roster still comes from the resource's own pipeline.
  assertEquals(payload.resource.pipeline_id, "I9t8njpuR0Dm7B2NDcvI");
});

Deno.test("week_start defaults to the current Perth week when omitted", async () => {
  const payload = await salesBookingRead(deps(), { resource: "marnin" });
  assertEquals(payload.week_start, "2026-09-14");
  assertEquals(payload.week.since, "2026-09-14T00:00:00+08:00");
});

// ── Structural: the action is read-only ─────────────────────

Deno.test("the module declares no write verb on any dependency", async () => {
  const source = await Deno.readTextFile(new URL("./sales_booking_read.ts", import.meta.url));
  // A PostgREST write, a GHL POST, or a calendar create would each show here.
  for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assertEquals(
      source.includes(forbidden),
      false,
      `sales_booking_read must stay read-only; found ${forbidden}`,
    );
  }
  // Only GET reads leave this module.
  assertEquals(source.includes("method: 'POST'"), false);
  assertEquals(source.includes('method: "POST"'), false);
});
