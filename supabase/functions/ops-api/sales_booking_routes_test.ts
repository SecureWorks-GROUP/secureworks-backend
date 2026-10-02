// deno-lint-ignore-file no-import-prefix
// Booking routes (sales_booking_routes.ts): each route of the owner's 28 Sep
// mapping, a reordered and a disabled rule, no match, and proof that with
// every switch off each press is still a dry run naming the route's calendar.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bookingContentHash,
  bookingHash,
  type ExecutableApprovalRecord,
} from "../_shared/booking_approval_gate.ts";
import {
  type BookingApprovalRecord,
  type BookingApprovalStore,
  type BookingObject,
  salesBookingApprovalWriteRoute,
} from "./sales_booking_confirmation.ts";
import type { OwnerApprovalDeps } from "./sales_booking_owner_approval.ts";
import {
  salesBookingLeadBelongsTo,
  salesBookingRead,
  type SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import {
  resolveSalesBookingRoute,
  SALES_BOOKING_FENCING_PIPELINE_ID,
  SALES_BOOKING_PATIO_PIPELINE_ID,
  SALES_BOOKING_SEED_ROUTES,
  type SalesBookingRoute,
  validateSalesBookingRouteInput,
} from "./sales_booking_routes.ts";
import {
  type SalesBookingRouteChange,
  type SalesBookingRoutesDeps,
  SalesBookingRoutesError,
  salesBookingRoutesReadAction,
  salesBookingRoutesWriteAction,
} from "./sales_booking_routes_actions.ts";
import {
  type ExecuteResult,
  salesBookingBookAction,
  type SalesBookingExecuteDeps,
  salesBookingSendAction,
} from "./sales_booking_execute.ts";
import {
  SALES_BOOKING_SENDER_LINES,
  SALES_BOOKING_STRATCO_CALENDAR_ID,
  type SalesBookingLeadKind,
  type SalesBookingOpportunityOwnership,
} from "./sales_booking_sender.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
const FENCING = SALES_BOOKING_FENCING_PIPELINE_ID;
const PATIO = SALES_BOOKING_PATIO_PIPELINE_ID;
const FENCING_SCOPE = "i6j9vaCy6c94n3i93cir";
const NITHIN_SCOPE = "RSQnT8cQdEE8azb5Chlq";
const GHL = {
  marnin: SALES_BOOKING_SENDER_LINES.marnin.ghl_user_id,
  khairo: SALES_BOOKING_SENDER_LINES.khairo.ghl_user_id,
  nithin: SALES_BOOKING_SENDER_LINES.nithin.ghl_user_id,
};
const seed = (): SalesBookingRoute[] =>
  SALES_BOOKING_SEED_ROUTES.map((r) => ({ ...r }));
const lead = (
  pipelineId: string,
  kind: SalesBookingLeadKind,
  extra: Partial<SalesBookingOpportunityOwnership> = {},
): SalesBookingOpportunityOwnership => ({
  assignedTo: null,
  pipelineId,
  kind,
  tags: [],
  ...extra,
});
const routeOf = (
  routes: SalesBookingRoute[],
  l: SalesBookingOpportunityOwnership,
) => resolveSalesBookingRoute(routes, { ...l, tags: l.tags ?? null });

// ── The owner's 28 Sep mapping ────────────────────────────────────────────

Deno.test("seed: Stratco fencing is Marnin's into STRATCO FENCING, other fencing Khairo's into Fencing Scope, patio Nithin's", () => {
  const cases: Array<
    [SalesBookingOpportunityOwnership, string, string, string]
  > = [
    [
      lead(FENCING, "stratco"),
      "marnin",
      SALES_BOOKING_STRATCO_CALENDAR_ID,
      "stratco-fencing-marnin",
    ],
    [lead(FENCING, "normal"), "khairo", FENCING_SCOPE, "normal-fencing-khairo"],
    [lead(PATIO, "unclear"), "nithin", NITHIN_SCOPE, "patio-nithin"],
  ];
  for (const [l, person, calendar, id] of cases) {
    const decided = routeOf(seed(), l);
    assert(decided.ok);
    assertEquals(
      [decided.route.person, decided.route.calendar_id, decided.route.id],
      [person, calendar, id],
    );
    for (const resource of ["marnin", "khairo", "nithin"]) {
      assertEquals(
        salesBookingLeadBelongsTo(l, resource, seed()),
        resource === person ? "yes" : "no",
      );
    }
  }
  // The Stratco calendar is unchanged from the hard-coded one it replaces.
  assertEquals(
    SALES_BOOKING_SEED_ROUTES[0].calendar_id,
    "dEQKVKHthsjSYaen1fiE",
  );
});

Deno.test("no match: an unclear fencing lead is held on Marnin's list, never Khairo's, and has no route", () => {
  const unclear = lead(FENCING, "unclear");
  const decided = routeOf(seed(), unclear);
  assert(!decided.ok);
  assertEquals(decided.reason, "booking_route_missing");
  assert(decided.message.includes("cannot be booked"));
  assertEquals(
    salesBookingLeadBelongsTo(unclear, "marnin", seed()),
    "owner_unclear",
  );
  assertEquals(salesBookingLeadBelongsTo(unclear, "khairo", seed()), "no");
  // A source that could not be read stops at the first rule that needs it:
  // a later, broader rule never catches a lead the Stratco rule might claim.
  const broad = [...seed(), {
    ...seed()[1],
    id: "all-fencing-khairo",
    position: 40,
    match_lead_source: null,
  }];
  const unread = routeOf(broad, lead(FENCING, "unclear", { kindUnread: true }));
  assert(!unread.ok);
  assertEquals(unread.reason, "booking_route_lead_source_unread");
  assertEquals(unread.route_id, "stratco-fencing-marnin");
  // No rules at all (an unreadable table): every unassigned lead is held.
  assertEquals(
    salesBookingLeadBelongsTo(lead(PATIO, "unclear"), "nithin", []),
    "owner_unclear",
  );
  assertEquals(
    salesBookingLeadBelongsTo(lead(FENCING, "stratco"), "marnin", []),
    "owner_unclear",
  );
});

Deno.test("reordered rule: a catch-all fencing rule above Stratco sends Stratco leads to Khairo", () => {
  const routes = seed();
  routes[1] = { ...routes[1], position: 5, match_lead_source: null };
  const decided = routeOf(routes, lead(FENCING, "stratco"));
  assert(decided.ok);
  assertEquals([decided.route.person, decided.route.calendar_id], [
    "khairo",
    FENCING_SCOPE,
  ]);
  assertEquals(
    salesBookingLeadBelongsTo(lead(FENCING, "stratco"), "khairo", routes),
    "yes",
  );
  assertEquals(
    salesBookingLeadBelongsTo(lead(FENCING, "stratco"), "marnin", routes),
    "no",
  );
});

Deno.test("disabled rule: switching off the Stratco rule leaves Stratco leads unrouted and unbookable", () => {
  const routes = seed();
  routes[0] = { ...routes[0], enabled: false };
  const decided = routeOf(routes, lead(FENCING, "stratco"));
  assert(!decided.ok);
  assertEquals(decided.reason, "booking_route_missing");
  assertEquals(
    salesBookingLeadBelongsTo(lead(FENCING, "stratco"), "marnin", routes),
    "owner_unclear",
  );
  // Normal fencing and patio are untouched.
  assert(routeOf(routes, lead(FENCING, "normal")).ok);
  assert(routeOf(routes, lead(PATIO, "unclear")).ok);
});

Deno.test("tag rule: a tagged lead goes to its rule first; an unread tag set stops there", () => {
  const routes = [...seed(), {
    ...seed()[0],
    id: "vip-fencing-nithin",
    position: 1,
    match_lead_source: null,
    match_tag: "VIP",
    person: "nithin",
    calendar_id: NITHIN_SCOPE,
  }];
  const vip = routeOf(routes, lead(FENCING, "normal", { tags: ["vip"] }));
  assert(vip.ok);
  assertEquals(vip.route.id, "vip-fencing-nithin");
  const plain = routeOf(
    routes,
    lead(FENCING, "normal", { tags: ["web - enquiry"] }),
  );
  assert(plain.ok);
  assertEquals(plain.route.id, "normal-fencing-khairo");
  const unread = routeOf(routes, lead(FENCING, "normal", { tags: null }));
  assert(!unread.ok);
  assertEquals(unread.reason, "booking_route_tags_unread");
});

Deno.test("assigned lead: the GHL assignee wins and books into their own rule for the trade", () => {
  // A Stratco lead assigned to Khairo books into his Fencing Scope calendar.
  const toKhairo = lead(FENCING, "stratco", { assignedTo: GHL.khairo });
  const decided = routeOf(seed(), toKhairo);
  assert(decided.ok);
  assertEquals([decided.route.person, decided.route.calendar_id], [
    "khairo",
    FENCING_SCOPE,
  ]);
  assertEquals(salesBookingLeadBelongsTo(toKhairo, "khairo", seed()), "yes");
  assertEquals(salesBookingLeadBelongsTo(toKhairo, "marnin", seed()), "no");
  // A patio lead assigned to Marnin: his lead, but no rule of his is patio.
  const patioMarnin = routeOf(
    seed(),
    lead(PATIO, "unclear", { assignedTo: GHL.marnin }),
  );
  assert(!patioMarnin.ok);
  assertEquals(patioMarnin.reason, "booking_route_missing");
  // Assigned to someone who does not book here.
  const stranger = routeOf(
    seed(),
    lead(FENCING, "normal", { assignedTo: "someone" }),
  );
  assert(!stranger.ok);
  assertEquals(stranger.reason, "booking_route_assignee_not_booking_person");
});

Deno.test("validation: an owner edit names a known person and well-formed ids", () => {
  const good = validateSalesBookingRouteInput("stratco-fencing-marnin", {
    position: 10,
    enabled: true,
    match_trade: "fencing",
    match_lead_source: "stratco",
    person: "marnin",
    calendar_id: SALES_BOOKING_STRATCO_CALENDAR_ID,
  });
  assert(good.ok);
  const bad: Array<[string, Obj, string]> = [
    ["Bad Id", {}, "id"],
    ["r", {
      position: 0,
      enabled: true,
      person: "marnin",
      calendar_id: FENCING_SCOPE,
    }, "position"],
    ["r", {
      position: 1,
      enabled: "yes",
      person: "marnin",
      calendar_id: FENCING_SCOPE,
    }, "enabled"],
    ["r", {
      position: 1,
      enabled: true,
      match_trade: "roofing",
      person: "marnin",
      calendar_id: FENCING_SCOPE,
    }, "match_trade"],
    ["r", {
      position: 1,
      enabled: true,
      match_lead_source: "mlb",
      person: "marnin",
      calendar_id: FENCING_SCOPE,
    }, "match_lead_source"],
    ["r", {
      position: 1,
      enabled: true,
      person: "shaun",
      calendar_id: FENCING_SCOPE,
    }, "person"],
    ["r", {
      position: 1,
      enabled: true,
      person: "marnin",
      calendar_id: "not a calendar",
    }, "calendar_id"],
  ];
  for (const [id, raw, field] of bad) {
    const checked = validateSalesBookingRouteInput(id, raw);
    assert(!checked.ok);
    assertEquals(checked.field, field);
  }
});

// ── The booking list ──────────────────────────────────────────────────────

const NOW = new Date("2026-09-23T02:00:00Z"); // Wed 10:00 Perth

function listDeps(
  rows: Obj[],
  routes: () => Promise<SalesBookingRoute[]>,
) {
  return {
    readOpportunities: () =>
      Promise.resolve({
        opportunities: rows,
        stages: {},
        exhausted: true,
        total: rows.length,
        pages_scanned: 1,
        reason: null,
      }),
    readDiary: () =>
      Promise.resolve({
        read_ok: false,
        reason: "test",
        entries: [],
        malformed_dropped: 0,
        calendar_email: null,
        ghl_user_id: null,
        mapped_by: null,
        scoper_user_id: null,
      }),
    readThread: () => Promise.resolve([]),
    readContacts: (ids: string[]) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, { tags: [] }]))),
    readContactStratcoBooked: () => Promise.resolve(false),
    readRoutes: routes,
    now: () => NOW,
  };
}

const opp = (id: string, extra: Obj) => ({
  id,
  name: `Lead ${id}`,
  pipelineId: FENCING,
  pipelineStageId: "7f863a14-1d9f-4a18-b73c-0e1780390bd7",
  assignedTo: null,
  contactId: `c-${id}`,
  contact: { id: `c-${id}`, name: `Lead ${id}` },
  ...extra,
});

Deno.test("list: each lead carries its route; Khairo's list holds his normal fencing lead with his calendar", async () => {
  const rows = [
    opp("s1", { source: "Stratco allocation" }),
    opp("n1", { source: "Website Enquiry" }),
    opp("u1", {}),
  ];
  const read = (resource: string) =>
    salesBookingRead(listDeps(rows, () => Promise.resolve(seed())), {
      resource,
      week_start: "2026-09-21",
    });
  const marnin = await read("marnin");
  const byId = Object.fromEntries(marnin.cases.map((c) => [c.id, c]));
  assertEquals(Object.keys(byId).sort(), ["s1", "u1"]);
  assertEquals(
    byId.s1.booking_route?.calendar_id,
    SALES_BOOKING_STRATCO_CALENDAR_ID,
  );
  assertEquals(byId.u1.booking_route?.state, "not_routed");
  assertEquals(byId.u1.owner_unclear, true);
  assertEquals(marnin.routing?.ok, true);
  const khairo = await read("khairo");
  assertEquals(khairo.cases.map((c) => c.id), ["n1"]);
  assertEquals(khairo.cases[0].booking_route?.calendar_id, FENCING_SCOPE);
  assertEquals(
    khairo.cases[0].booking_route?.route_id,
    "normal-fencing-khairo",
  );
});

Deno.test("list: unreadable routes hold every unassigned lead and name the gap", async () => {
  const rows = [opp("s1", { source: "Stratco allocation" })];
  const marnin = await salesBookingRead(
    listDeps(
      rows,
      () => Promise.reject(new Error("booking_routes_unreadable")),
    ),
    { resource: "marnin", week_start: "2026-09-21" },
  );
  assertEquals(marnin.routing?.ok, false);
  assertEquals(marnin.cases[0].owner_unclear, true);
  assertEquals(
    marnin.cases[0].booking_route?.reason,
    "booking_routes_unreadable",
  );
  assert(
    marnin.coverage.gaps.some((g) =>
      g.includes("Booking rules could not be read")
    ),
  );
});

// ── Owner approvals: a visit per route ────────────────────────────────────

const CONTACT = "n9rqiejpF3Sp8OG8MyRN";
const CASE = "opp:lead-opp";
const auth = {
  mode: "jwt" as const,
  email: "marnin@secureworkswa.com.au",
  userId: "706c5258-70dd-483a-b36c-af6864b24498",
};
const FRI = {
  window_start_iso: "2026-09-25T09:00:00+08:00",
  window_end_iso: "2026-09-25T10:30:00+08:00",
  end_iso: "2026-09-25T11:00:00+08:00",
};

async function workspace(resource: string): Promise<SalesBookingReadResponse> {
  const read = await salesBookingRead({
    ...listDeps([], () => Promise.resolve(seed())),
  }, { resource, week_start: "2026-09-21" });
  read.cases = [{
    id: CASE,
    opportunity_id: "lead-opp",
    contact_id: CONTACT,
    resource_id: resource,
  }] as SalesBookingReadResponse["cases"];
  return read;
}

function memoryStore(rows: BookingApprovalRecord[] = []): BookingApprovalStore {
  return {
    find: (hashes) =>
      Promise.resolve(rows.filter((r) => hashes.includes(r.binding_hash))),
    insert(record) {
      rows.push(structuredClone(record));
      return Promise.resolve(record);
    },
  };
}

function ownerDeps(
  resource: string,
  ownership: SalesBookingOpportunityOwnership,
  routes: () => Promise<SalesBookingRoute[]> = () => Promise.resolve(seed()),
) {
  const calls: string[] = [];
  const d: OwnerApprovalDeps = {
    store: memoryStore(),
    readWorkspace: () => workspace(resource),
    readLead: () =>
      Promise.resolve({
        contact: {
          id: CONTACT,
          firstName: "Sam",
          lastName: "Sample",
          phone: "0412 345 678",
          address1: "12 Fictional Way",
        },
        suburb: "Canning Vale",
        job_site: null,
      }),
    readThread: () => Promise.resolve([]),
    readOpportunityOwnership: (_id, options) => {
      calls.push(`ownership:forRoute=${options?.forRoute}`);
      return Promise.resolve(ownership);
    },
    readRoutes: routes,
    readGhlDirectory: () =>
      Promise.resolve({
        calendars: [
          [SALES_BOOKING_STRATCO_CALENDAR_ID, GHL.marnin],
          [FENCING_SCOPE, GHL.khairo],
          [NITHIN_SCOPE, GHL.nithin],
        ].map(([id, user]) => ({
          id,
          is_active: true,
          assigned_user_ids: [user],
          assignments_returned: true,
        })),
        users: [
          { id: GHL.marnin, email: "marnin@secureworkswa.com.au" },
          { id: GHL.khairo, email: "khairopomare@outlook.com" },
          { id: GHL.nithin, email: "nithinsilas@outlook.com" },
        ],
      }),
    readGhlEvents: (selector) => {
      calls.push(`ghl:${JSON.stringify(selector)}`);
      return Promise.resolve([]);
    },
    readGhlBlockedSlots: (userId) => {
      calls.push(`blocked:${userId}`);
      return Promise.resolve([]);
    },
    readOutlook: (who) => {
      calls.push(`outlook:${who}`);
      return Promise.resolve({
        ok: true as const,
        mailbox: `${who}@x`,
        events: [],
      });
    },
    readSystemOfferRecords: () =>
      Promise.resolve({ executions: [], approvals: [] }),
    envGet: () => undefined,
    now: () => NOW,
  };
  return { deps: d, calls };
}

function preview(
  d: OwnerApprovalDeps,
  owner: BookingObject,
): Promise<BookingObject> {
  const { store, readWorkspace, envGet, now, ...owned } = d;
  return salesBookingApprovalWriteRoute({
    store,
    auth: auth as never,
    body: { owner_input: owner, dry_run: true },
    method: "POST",
    readWorkspace,
    envGet,
    now,
    owner: owned,
  });
}

const visitInput = (resource: string) => ({
  resource,
  step: "calendar",
  case_id: CASE,
  contact_id: CONTACT,
  week_start: "2026-09-21",
  visit: FRI,
});

Deno.test("approval: one visit per route lands in that route's calendar, for that person, read from the table at the press", async () => {
  const people: Array<[string, SalesBookingOpportunityOwnership, string]> = [
    ["marnin", lead(FENCING, "stratco"), SALES_BOOKING_STRATCO_CALENDAR_ID],
    ["khairo", lead(FENCING, "normal"), FENCING_SCOPE],
    ["nithin", lead(PATIO, "unclear"), NITHIN_SCOPE],
  ];
  for (const [resource, ownership, calendar] of people) {
    const { deps, calls } = ownerDeps(resource, ownership);
    const result = await preview(deps, visitInput(resource));
    assertEquals(result.dry_run, true);
    assertEquals(result.snapshot.resource, resource);
    assertEquals(result.snapshot.content.calendar_id, calendar);
    assertEquals(
      result.snapshot.content.assigned_user_id,
      GHL[resource as keyof typeof GHL],
    );
    assertEquals(result.checks.route.calendar_id, calendar);
    assertEquals(result.checks.ghl.calendar_id, calendar);
    // The route's person's own diary, blocked time and Outlook were read.
    assert(calls.includes(`blocked:${GHL[resource as keyof typeof GHL]}`));
    assert(calls.includes(`outlook:${resource}`));
    assert(calls.includes("ownership:forRoute=true"));
  }
});

Deno.test("approval: a visit on a day outside the person's own rules is refused (Nithin does not work Wednesdays)", async () => {
  const { deps } = ownerDeps("nithin", lead(PATIO, "unclear"));
  await assertRejects(
    () =>
      preview(deps, {
        ...visitInput("nithin"),
        visit: {
          window_start_iso: "2026-09-30T09:00:00+08:00",
          window_end_iso: "2026-09-30T10:30:00+08:00",
          end_iso: "2026-09-30T11:00:00+08:00",
        },
      }),
    Error,
    "owner_visit_day_not_permitted",
  );
  // Monday starts at 12:00 for Nithin.
  await assertRejects(
    () =>
      preview(deps, {
        ...visitInput("nithin"),
        visit: {
          window_start_iso: "2026-09-28T09:00:00+08:00",
          window_end_iso: "2026-09-28T10:30:00+08:00",
          end_iso: "2026-09-28T11:00:00+08:00",
        },
      }),
    Error,
    "owner_visit_outside_hours",
  );
});

Deno.test("approval: no route, a route to someone else, and an unreadable table each refuse the visit with a reason", async () => {
  // An unclear fencing lead on Marnin's list: no rule matches it.
  const unclear = ownerDeps("marnin", lead(FENCING, "unclear"));
  await assertRejects(
    () => preview(unclear.deps, visitInput("marnin")),
    Error,
    "booking_route_missing",
  );
  // The Stratco rule switched off: the Stratco lead has no route either.
  const off = ownerDeps(
    "marnin",
    lead(FENCING, "stratco"),
    () =>
      Promise.resolve(
        seed().map((r) =>
          r.id === "stratco-fencing-marnin" ? { ...r, enabled: false } : r
        ),
      ),
  );
  await assertRejects(
    () => preview(off.deps, visitInput("marnin")),
    Error,
    "booking_route_missing",
  );
  // Reordered so Khairo takes Stratco: Marnin cannot book it.
  const moved = ownerDeps(
    "marnin",
    lead(FENCING, "stratco"),
    () =>
      Promise.resolve(
        seed().map((r) =>
          r.id === "normal-fencing-khairo"
            ? { ...r, position: 1, match_lead_source: null }
            : r
        ),
      ),
  );
  await assertRejects(
    () => preview(moved.deps, visitInput("marnin")),
    Error,
    "booking_route_other_person",
  );
  const broken = ownerDeps(
    "marnin",
    lead(FENCING, "stratco"),
    () => Promise.reject(new Error("down")),
  );
  await assertRejects(
    () => preview(broken.deps, visitInput("marnin")),
    Error,
    "booking_routes_unreadable",
  );
});

// ── Presses: every switch off means a dry run ─────────────────────────────

const PRESS_NOW = new Date("2026-09-24T01:00:00Z");
const CAPTAIN = {
  mode: "jwt" as const,
  email: "marnin@secureworkswa.com.au",
  userId: "u1",
};

async function calendarApproval(
  resource: string,
  calendarId: string,
): Promise<ExecutableApprovalRecord> {
  const snapshot: Obj = {
    schema: "scope-booking-approval.v1",
    source: "owner",
    step: "calendar",
    case_id: CASE,
    contact_id: CONTACT,
    resource,
    scoper_user_id: SALES_BOOKING_SENDER_LINES[resource].scoper_user_id,
    week_start: "2026-09-21",
    id: "opp:lead-opp",
    profile: SALES_BOOKING_SENDER_LINES[resource].profile,
    pack_revision: null,
    content_hash: null,
    content: {
      provider: "ghl",
      calendar_id: calendarId,
      assigned_user_id: GHL[resource as keyof typeof GHL],
      start_iso: "2026-09-25T09:00:00+08:00",
      end_iso: "2026-09-25T11:00:00+08:00",
      window_start_iso: "2026-09-25T09:00:00+08:00",
      window_end_iso: "2026-09-25T10:30:00+08:00",
      title: "Scope visit: Sam Sample",
      address: "12 Fictional Way, Canning Vale",
    },
  };
  snapshot.content_hash = await bookingContentHash(snapshot);
  return {
    binding_hash: await bookingHash(snapshot),
    step: "calendar",
    state: "approved",
    snapshot,
    approved_by_email: CAPTAIN.email,
    approved_at: new Date(PRESS_NOW.getTime() - 60_000).toISOString(),
    expires_at: new Date(PRESS_NOW.getTime() + 14 * 60_000).toISOString(),
  };
}

function pressDeps(
  record: ExecutableApprovalRecord,
  ownership: SalesBookingOpportunityOwnership,
  routes: () => Promise<SalesBookingRoute[]> = () => Promise.resolve(seed()),
) {
  const calls = { writer: [] as Obj[], claims: 0, sms: 0, outlookPosts: 0 };
  const deps: SalesBookingExecuteDeps = {
    findApproval: () => Promise.resolve(record),
    appointmentLedger: () => Promise.resolve(null),
    readThread: () => Promise.resolve([]),
    readOutlook: (who) =>
      Promise.resolve({ ok: true as const, mailbox: `${who}@x`, events: [] }),
    readContactPhone: () => Promise.resolve("+61412345678"),
    readOpportunityOwnership: () => Promise.resolve(ownership),
    readRoutes: routes,
    readOutlookLead: () =>
      Promise.resolve({
        contact: { id: CONTACT, firstName: "Sam", lastName: "Sample" },
        suburb: "Canning Vale",
      }),
    mirrorToOutlook: () => {
      calls.outlookPosts++;
      return Promise.reject(new Error("no Outlook write in a dry run"));
    },
    callAppointmentWriter: (body) => {
      calls.writer.push(body);
      // The GHL writer's own switch is off: it previews, never posts.
      return Promise.resolve({
        status: 200,
        body: {
          ok: false,
          code: "flag_off",
          dryRun: true,
          wouldWrite: {
            method: "POST",
            body: {
              calendarId: body.calendarId,
              startTime: body.startTime,
              endTime: body.endTime,
            },
          },
        },
      });
    },
    callSendSms: () => {
      calls.sms++;
      return Promise.reject(new Error("no send in a dry run"));
    },
    executions: {
      get: () => Promise.resolve(null),
      claim: () => {
        calls.claims++;
        return Promise.resolve(true);
      },
      settle: () => Promise.resolve(),
    },
    // Every switch off: SALES_BOOKING_BOOK_EXECUTE, SALES_BOOKING_SEND_EXECUTE.
    envGet: () => undefined,
    now: () => PRESS_NOW,
  };
  return { deps, calls };
}

const press = (
  kind: "book" | "send",
  deps: SalesBookingExecuteDeps,
  id: string,
) =>
  (kind === "book" ? salesBookingBookAction : salesBookingSendAction)({
    auth: CAPTAIN,
    body: { approval_id: id },
    method: "POST",
    deps,
  });

Deno.test("trial mode: with every switch off, a captain's book press per route is a dry run into that route's calendar", async () => {
  const people: Array<[string, SalesBookingOpportunityOwnership, string]> = [
    ["marnin", lead(FENCING, "stratco"), SALES_BOOKING_STRATCO_CALENDAR_ID],
    ["khairo", lead(FENCING, "normal"), FENCING_SCOPE],
    ["nithin", lead(PATIO, "unclear"), NITHIN_SCOPE],
  ];
  for (const [resource, ownership, calendar] of people) {
    const record = await calendarApproval(resource, calendar);
    const { deps, calls } = pressDeps(record, ownership);
    const result: ExecuteResult = await press(
      "book",
      deps,
      record.binding_hash,
    );
    assertEquals(result.status, "dry_run");
    assertEquals(
      result.status === "dry_run" && result.reason,
      "book_switch_off",
    );
    assertEquals(calls.writer.length, 1);
    assertEquals(calls.writer[0].dryRun, true);
    assertEquals(calls.writer[0].calendarId, calendar);
    assertEquals(
      calls.writer[0].assignedUserId,
      GHL[resource as keyof typeof GHL],
    );
    assertEquals([calls.claims, calls.sms, calls.outlookPosts], [0, 0, 0]);
  }
});

Deno.test("book press: a rule changed since approval refuses before the writer is called", async () => {
  const record = await calendarApproval("khairo", FENCING_SCOPE);
  // The owner pointed Khairo's rule at another calendar after approving.
  const moved = pressDeps(
    record,
    lead(FENCING, "normal"),
    () =>
      Promise.resolve(
        seed().map((r) =>
          r.id === "normal-fencing-khairo"
            ? { ...r, calendar_id: "NewCalendar0001" }
            : r
        ),
      ),
  );
  const changed = await press("book", moved.deps, record.binding_hash);
  assertEquals(
    changed.status === "refused" && changed.reason,
    "booking_route_changed",
  );
  assertEquals(moved.calls.writer.length, 0);
  // The rule switched off: no route at all.
  const off = pressDeps(
    record,
    lead(FENCING, "normal"),
    () =>
      Promise.resolve(
        seed().map((r) =>
          r.id === "normal-fencing-khairo" ? { ...r, enabled: false } : r
        ),
      ),
  );
  const none = await press("book", off.deps, record.binding_hash);
  assertEquals(
    none.status === "refused" && none.reason,
    "booking_route_missing",
  );
  assertEquals(off.calls.writer.length, 0);
  // The lead is now Stratco: its route is Marnin's, no longer Khairo's.
  const theirs = pressDeps(record, lead(FENCING, "stratco"));
  const other = await press("book", theirs.deps, record.binding_hash);
  assertEquals(
    other.status === "refused" && other.reason,
    "booking_route_changed",
  );
  // Assigned in GHL to Marnin since approval: not Khairo's lead any more.
  const reassigned = pressDeps(
    record,
    lead(FENCING, "normal", { assignedTo: GHL.marnin }),
  );
  const moved2 = await press("book", reassigned.deps, record.binding_hash);
  assertEquals(
    moved2.status === "refused" && moved2.reason,
    "opportunity_assignee_changed",
  );
  assertEquals([theirs.calls.writer.length, reassigned.calls.writer.length], [
    0,
    0,
  ]);
  // An unreadable table refuses.
  const broken = pressDeps(
    record,
    lead(FENCING, "normal"),
    () => Promise.reject(new Error("down")),
  );
  const unread = await press("book", broken.deps, record.binding_hash);
  assertEquals(
    unread.status === "refused" && unread.reason,
    "booking_routes_unreadable",
  );
});

Deno.test("trial mode: a captain's send press for Khairo's lead is a dry run from his own line", async () => {
  const snapshot: Obj = {
    schema: "scope-booking-approval.v1",
    source: "owner",
    step: "message",
    case_id: CASE,
    contact_id: CONTACT,
    resource: "khairo",
    scoper_user_id: SALES_BOOKING_SENDER_LINES.khairo.scoper_user_id,
    week_start: "2026-09-21",
    id: "opp:lead-opp",
    profile: SALES_BOOKING_SENDER_LINES.khairo.profile,
    pack_revision: null,
    content_hash: null,
    content: {
      text: "Hi Sam, does Friday suit for a look at the fence?",
      sender: SALES_BOOKING_SENDER_LINES.khairo.line,
      recipient: "+61412345678",
      variant: "owner",
      offer: null,
    },
  };
  snapshot.content_hash = await bookingContentHash(snapshot);
  const record: ExecutableApprovalRecord = {
    binding_hash: await bookingHash(snapshot),
    step: "message",
    state: "approved",
    snapshot,
    approved_by_email: CAPTAIN.email,
    approved_at: new Date(PRESS_NOW.getTime() - 60_000).toISOString(),
    expires_at: new Date(PRESS_NOW.getTime() + 14 * 60_000).toISOString(),
  };
  const { deps, calls } = pressDeps(record, lead(FENCING, "normal"));
  const result = await press("send", deps, record.binding_hash);
  assertEquals(result.status, "dry_run");
  assertEquals(result.status === "dry_run" && result.reason, "send_switch_off");
  assertEquals(
    result.status === "dry_run" && result.would_send?.body.fromNumber,
    "+61489267772",
  );
  assertEquals([calls.sms, calls.claims], [0, 0]);
});

// ── The owner's edit door ─────────────────────────────────────────────────

function routesDeps(initial = seed()) {
  let routes = initial.map((r) => ({
    ...r,
    updated_at: "2026-10-02T01:00:00.000000+00:00",
  }));
  const writes: Obj[] = [];
  const changes: SalesBookingRouteChange[] = [];
  const deps: SalesBookingRoutesDeps = {
    loadRoutes: () => Promise.resolve(routes.map((r) => ({ ...r }))),
    loadChanges: () => Promise.resolve(changes),
    writeRoute(args) {
      writes.push(args);
      const before = routes.find((r) => r.id === args.route_id) ?? null;
      if (
        args.op !== "create" && before?.updated_at !== args.expected_updated_at
      ) {
        return Promise.reject(new Error("route_changed_since_read"));
      }
      routes = routes.filter((r) => r.id !== args.route_id);
      if (args.route) {
        routes.push({
          ...(args.route as SalesBookingRoute),
          id: args.route_id,
          updated_at: "2026-10-02T02:00:00.000000+00:00",
        });
      }
      return Promise.resolve({ op: args.op, route_id: args.route_id, before });
    },
    envGet: () => undefined,
  };
  return { deps, writes };
}

const OWNER = {
  mode: "jwt" as const,
  email: "marnin@secureworkswa.com.au",
  userId: "706c5258-70dd-483a-b36c-af6864b24498",
};
const disableStratco = {
  op: "update",
  route_id: "stratco-fencing-marnin",
  expected_updated_at: "2026-10-02T01:00:00.000000+00:00",
  route: { ...SALES_BOOKING_SEED_ROUTES[0], enabled: false },
  reason: "trial",
};

Deno.test("edit door: read lists the rules in order with the people and filters a rule may use", async () => {
  const { deps } = routesDeps();
  const read = await salesBookingRoutesReadAction({ method: "GET", deps });
  assertEquals(read.read_order, [
    "stratco-fencing-marnin",
    "normal-fencing-khairo",
    "patio-nithin",
  ]);
  assertEquals(read.choices.people.map((p: Obj) => p.person).sort(), [
    "khairo",
    "marnin",
    "nithin",
  ]);
  assertEquals(read.choices.match_trade, ["fencing", "patio"]);
  await assertRejects(
    () => salesBookingRoutesReadAction({ method: "POST", deps }),
    SalesBookingRoutesError,
    "requires GET",
  );
});

Deno.test("edit door: only the owner's signed session changes a rule, with who and why recorded", async () => {
  const { deps, writes } = routesDeps();
  // A staff session that is not the owner, and a desk key, cannot change it.
  await assertRejects(
    () =>
      salesBookingRoutesWriteAction({
        method: "POST",
        auth: {
          mode: "jwt",
          email: "shaun@secureworkswa.com.au",
          userId: "x",
        } as never,
        body: disableStratco,
        deps,
      }),
    Error,
  );
  await assertRejects(
    () =>
      salesBookingRoutesWriteAction({
        method: "POST",
        auth: { mode: "api_key" } as never,
        body: disableStratco,
        deps,
      }),
    Error,
  );
  assertEquals(writes.length, 0);
  // A desk key may preview: nothing is written.
  const dry = await salesBookingRoutesWriteAction({
    method: "POST",
    auth: { mode: "api_key" } as never,
    body: { ...disableStratco, dry_run: true },
    deps,
  });
  assertEquals(dry.dry_run, true);
  assertEquals(dry.read_order, ["normal-fencing-khairo", "patio-nithin"]);
  assertEquals(dry.stale, false);
  assertEquals(writes.length, 0);
  // The owner's change is written once, with his identity and reason.
  const done = await salesBookingRoutesWriteAction({
    method: "POST",
    auth: OWNER as never,
    body: disableStratco,
    deps,
  });
  assertEquals(done.dry_run, false);
  assertEquals(done.read_order, ["normal-fencing-khairo", "patio-nithin"]);
  assertEquals(writes.length, 1);
  assertEquals(
    [
      writes[0].actor_email,
      writes[0].actor_user_id,
      writes[0].reason,
      writes[0].route.enabled,
    ],
    [OWNER.email, OWNER.userId, "trial", false],
  );
  // The same edit again is now against a stale read.
  await assertRejects(
    () =>
      salesBookingRoutesWriteAction({
        method: "POST",
        auth: OWNER as never,
        body: disableStratco,
        deps,
      }),
    SalesBookingRoutesError,
    "route_changed_since_read",
  );
});

Deno.test("edit door: a malformed change, an unknown person or a missing version is refused before any write", async () => {
  const { deps, writes } = routesDeps();
  const refused = async (body: Obj, reason: string) => {
    const error = await assertRejects(
      () =>
        salesBookingRoutesWriteAction({
          method: "POST",
          auth: OWNER as never,
          body,
          deps,
        }),
      SalesBookingRoutesError,
    );
    assertEquals(error.reason, reason);
  };
  await refused({ ...disableStratco, op: "replace" }, "route_op_invalid");
  await refused({
    ...disableStratco,
    route: { ...disableStratco.route, person: "shaun" },
  }, "route_person_unknown");
  await refused(
    { ...disableStratco, expected_updated_at: undefined },
    "route_expected_updated_at_required",
  );
  await refused({ ...disableStratco, op: "create" }, "route_exists");
  await refused({
    op: "delete",
    route_id: "no-such-rule",
    expected_updated_at: "x",
  }, "route_not_found");
  assertEquals(writes.length, 0);
});
