// deno-lint-ignore-file no-import-prefix
// Owner 2026-09-24: "khairo is all normal fencing all stratco fencing is
// mine." Unassigned fencing with any Stratco signal is Marnin's, with a
// positive normal-lead signal Khairo's, and with neither owner unclear (on
// Marnin's list, flagged, never approved or texted); unassigned patio is
// Nithin's, and an explicit GHL assignee always wins. A lead already booked with a scoper shows as booked with them and
// leaves every to-contact list.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  readSalesBookingOpportunityOwnership,
  resolveSalesBookingLeadKind,
  SALES_BOOKING_RESOURCES,
  type SalesBookingContactFact,
  salesBookingLeadBelongsTo,
  type SalesBookingMessage,
  salesBookingRead,
  type SalesBookingReadDependencies,
} from "./sales_booking_read.ts";
import {
  SALES_BOOKING_SENDER_LINES,
  type SalesBookingLeadKind,
  salesBookingLeadKind,
} from "./sales_booking_sender.ts";
import { assertLeadBelongsToResource } from "./sales_booking_confirmation.ts";
import { applySalesBookingPackOverlay } from "./sales_booking_pack.ts";
import { applySalesBookingAvailability } from "./sales_booking_availability.ts";
import {
  applySalesBookingScopeAppointments,
  type SalesBookingScopeCalendarRead,
} from "./sales_booking_scope_appointment.ts";

const NOW = new Date("2026-09-24T08:00:00.000Z"); // Thu 24 Sep, 4pm Perth
const WEEK = "2026-09-28";
const FENCING = SALES_BOOKING_RESOURCES.marnin.pipeline_id;
const PATIO = SALES_BOOKING_RESOURCES.nithin.pipeline_id;
const STAGE = SALES_BOOKING_RESOURCES.marnin.scope_stage_ids[0];
const MARNIN = SALES_BOOKING_SENDER_LINES.marnin.ghl_user_id;
const KHAIRO = SALES_BOOKING_SENDER_LINES.khairo.ghl_user_id;
const NITHIN = SALES_BOOKING_SENDER_LINES.nithin.ghl_user_id;
/** Basil (Aubin Grove): Khairo booked him in GHL for Tue 29 Sep 10:00. */
const BASIL_CONTACT = "cS6dKRalWMgthDS9mELw";
const BASIL_VISIT = {
  id: "0iuacuMRFkRAaKt8dGPt",
  appointmentStatus: "confirmed",
  assignedUserId: KHAIRO,
  calendarId: "i6j9vaCy6c94n3i93cir",
  contactId: BASIL_CONTACT,
  startTime: "2026-09-29T10:00:00+08:00",
  endTime: "2026-09-29T10:30:00+08:00",
  title: " ",
  deleted: false,
};

function opp(
  id: string,
  assignedTo: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "New Enquiry",
    assignedTo,
    pipelineId: FENCING,
    pipelineStageId: STAGE,
    status: "open",
    source: "Website Enquiry",
    updatedAt: "2026-09-23T02:58:45.236Z",
    contact: {
      id: `contact-${id}`,
      name: `Lead ${id}`,
      tags: ["sw fencing"],
    },
    ...extra,
  };
}

function readDeps(
  opportunities: Record<string, unknown>[],
  extra: Partial<SalesBookingReadDependencies> = {},
): SalesBookingReadDependencies {
  return {
    readOpportunities: () =>
      Promise.resolve({
        opportunities,
        stages: { [STAGE]: "New Lead (Replied/ Contacted)" },
        exhausted: true,
        pages_scanned: 1,
        total: opportunities.length,
        reason: null,
      }),
    readDiary: ({ scoperUserId }) =>
      Promise.resolve({
        read_ok: true,
        reason: null,
        entries: [],
        malformed_dropped: 0,
        calendar_email: null,
        ghl_user_id: null,
        mapped_by: "email",
        scoper_user_id: scoperUserId,
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
    readContacts: (ids) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, {}]))),
    readContactStratcoBooked: () => Promise.resolve(false),
    now: () => NOW,
    ...extra,
  };
}

Deno.test("lead kind: any Stratco signal is Stratco, else a normal source or tag is normal, else unclear", () => {
  assertEquals(
    salesBookingLeadKind({ contact: { tags: ["Stratco"] } }),
    "stratco",
  );
  assertEquals(salesBookingLeadKind({ tags: ["stratco lead"] }), "stratco");
  assertEquals(
    salesBookingLeadKind({ name: "Sonia Stratco 231030" }),
    "stratco",
  );
  assertEquals(
    salesBookingLeadKind({ contact: { name: "Sonia Stratco" } }),
    "stratco",
  );
  assertEquals(
    salesBookingLeadKind({ source: "Stratco lead allocation" }),
    "stratco",
  );
  assertEquals(
    salesBookingLeadKind({ source: "Website Enquiry" }, {
      stratcoCalendarBooked: true,
    }),
    "stratco",
  );
  // A plain website fencing enquiry (live shape, 23 Sep) is normal.
  assertEquals(
    salesBookingLeadKind({
      name: "Bec",
      source: "Website Enquiry",
      contact: { tags: ["source:organic", "web - enquiry", "sw fencing"] },
    }),
    "normal",
  );
  assertEquals(salesBookingLeadKind({ source: "Google Ads" }), "normal");
  assertEquals(salesBookingLeadKind({ source: "Facebook" }), "normal");
  assertEquals(salesBookingLeadKind({ source: "Referral" }), "normal");
  assertEquals(salesBookingLeadKind({ source: "Call +61489267772" }), "normal");
  assertEquals(
    salesBookingLeadKind({ contact: { tags: ["answered-call"] } }),
    "normal",
  );
  // Stratco beats a normal signal.
  assertEquals(
    salesBookingLeadKind({ source: "Website Enquiry", tags: ["stratco"] }),
    "stratco",
  );
  // Neither: owner unclear.
  assertEquals(salesBookingLeadKind({ name: "New Enquiry" }), "unclear");
  assertEquals(
    salesBookingLeadKind({ contact: { tags: ["sw fencing"] } }),
    "unclear",
  );
  assertEquals(salesBookingLeadKind(null), "unclear");
});

Deno.test("lead kind: the Stratco allocation-ref custom field counts only when its env id is set", () => {
  const withField = {
    source: "Website Enquiry",
    customFields: [{ id: "alloc-field", fieldValueString: "SA-231030" }],
  };
  const onContact = {
    contact: { customFields: [{ id: "alloc-field", value: "SA-1" }] },
  };
  const blank = {
    source: "Website Enquiry",
    customFields: [{ id: "alloc-field", fieldValueString: " " }],
  };
  const prior = Deno.env.get("GHL_STRATCO_ALLOCATION_FIELD_ID");
  try {
    Deno.env.delete("GHL_STRATCO_ALLOCATION_FIELD_ID");
    assertEquals(salesBookingLeadKind(withField), "normal");
    Deno.env.set("GHL_STRATCO_ALLOCATION_FIELD_ID", "alloc-field");
    assertEquals(salesBookingLeadKind(withField), "stratco");
    assertEquals(salesBookingLeadKind(onContact), "stratco");
    assertEquals(salesBookingLeadKind(blank), "normal");
  } finally {
    if (prior === undefined) {
      Deno.env.delete("GHL_STRATCO_ALLOCATION_FIELD_ID");
    } else Deno.env.set("GHL_STRATCO_ALLOCATION_FIELD_ID", prior);
  }
});

Deno.test("whose lead: the explicit assignee wins; unassigned is Stratco Marnin, normal fencing Khairo, unclear held on Marnin's, patio Nithin", () => {
  const verdicts = (
    assignedTo: string | null,
    pipelineId: string,
    kind: SalesBookingLeadKind,
  ) =>
    Object.fromEntries(
      Object.keys(SALES_BOOKING_RESOURCES).map((resource) => [
        resource,
        salesBookingLeadBelongsTo({ assignedTo, pipelineId, kind }, resource),
      ]).filter(([, verdict]) => verdict !== "no"),
    );
  assertEquals(verdicts(null, FENCING, "stratco"), { marnin: "yes" });
  assertEquals(verdicts(null, FENCING, "normal"), { khairo: "yes" });
  assertEquals(verdicts(null, FENCING, "unclear"), {
    marnin: "owner_unclear",
  });
  assertEquals(verdicts(null, PATIO, "unclear"), { nithin: "yes" });
  assertEquals(verdicts(null, PATIO, "stratco"), { nithin: "yes" });
  // Explicit assignee overrides the rule in every direction.
  assertEquals(verdicts(MARNIN, FENCING, "normal"), { marnin: "yes" });
  assertEquals(verdicts(KHAIRO, FENCING, "stratco"), { khairo: "yes" });
  assertEquals(verdicts(KHAIRO, FENCING, "unclear"), { khairo: "yes" });
  assertEquals(verdicts(NITHIN, FENCING, "stratco"), { nithin: "yes" });
  // Someone who is not a booking person: nobody's here.
  assertEquals(verdicts("someone-else", FENCING, "stratco"), {});
});

Deno.test("read: each person's list follows the rule; owner unclear is flagged on Marnin's, never on Khairo's", async () => {
  const leads = [
    opp("stratco-unassigned", null, { source: "Stratco lead allocation" }),
    opp("plain-unassigned", null),
    opp("unclear-unassigned", null, { source: "" }),
    opp("plain-assigned-marnin", MARNIN),
    opp("stratco-assigned-khairo", KHAIRO, { name: "Stratco lead" }),
    opp("unclear-assigned-khairo", KHAIRO, { source: "" }),
  ];
  const cases = async (resource: string) =>
    (await salesBookingRead(readDeps(leads), {
      resource,
      week_start: WEEK,
    })).cases.sort((a, b) => a.id.localeCompare(b.id));
  const marnin = await cases("marnin");
  assertEquals(marnin.map((row) => row.id), [
    "plain-assigned-marnin",
    "stratco-unassigned",
    "unclear-unassigned",
  ]);
  assertEquals(
    marnin.map((row) => [row.owner_unclear ?? false, row.owner_unclear_label]),
    [
      [false, undefined],
      [false, undefined],
      [true, "Owner unclear, Stratco or normal?"],
    ],
  );
  const khairo = await cases("khairo");
  assertEquals(khairo.map((row) => row.id), [
    "plain-unassigned",
    "stratco-assigned-khairo",
    "unclear-assigned-khairo",
  ]);
  assert(khairo.every((row) => !row.owner_unclear));
});

Deno.test("read: a normal lead with any STRATCO FENCING appointment is Marnin's, not Khairo's", async () => {
  const leads = [opp("booked-cal", null), opp("plain", null)];
  const asked: string[] = [];
  const readContactStratcoBooked: SalesBookingReadDependencies[
    "readContactStratcoBooked"
  ] = (contactId) => {
    asked.push(contactId);
    return Promise.resolve(contactId === "contact-booked-cal");
  };
  const ids = async (resource: string) =>
    (await salesBookingRead(readDeps(leads, { readContactStratcoBooked }), {
      resource,
      week_start: WEEK,
    })).cases.map((row) => row.id);
  assertEquals(await ids("marnin"), ["booked-cal"]);
  assertEquals(await ids("khairo"), ["plain"]);
  assert(asked.includes("contact-booked-cal"));
});

Deno.test("read: when the contact or STRATCO FENCING calendar cannot be read, a normal lead is owner unclear on Marnin's list, withheld from Khairo's", async () => {
  const leads = [
    opp("plain", null),
    opp("stratco", null, { source: "Stratco lead allocation" }),
    opp("assigned-khairo", KHAIRO),
  ];
  for (
    const unread of [
      { readContactStratcoBooked: () => Promise.reject(new Error("GHL 500")) },
      { readContactStratcoBooked: undefined },
      { readContacts: () => Promise.reject(new Error("GHL 500")) },
      { readContacts: () => Promise.resolve({}) },
      { readContacts: undefined },
    ] as Partial<SalesBookingReadDependencies>[]
  ) {
    const read = async (resource: string) =>
      await salesBookingRead(readDeps(leads, unread), {
        resource,
        week_start: WEEK,
      });
    const marnin = await read("marnin");
    assertEquals(
      marnin.cases.map((row) => [row.id, row.owner_unclear ?? false]).sort(),
      [["plain", true], ["stratco", false]],
    );
    assert(
      marnin.coverage.gaps.some((gap) =>
        gap.includes("1 unassigned fencing lead(s) held as owner unclear")
      ),
    );
    assertEquals(marnin.coverage.full_population, true);
    const khairo = await read("khairo");
    assertEquals(khairo.cases.map((row) => row.id), ["assigned-khairo"]);
    assertEquals(khairo.coverage.full_population, false);
  }
});

Deno.test("read: an unassigned lead's kind counts its GHL contact read, which search rows omit", async () => {
  // Search rows carry no contact tags. Lead A's only Stratco signal is a
  // contact tag behind a Website source; lead B's only normal signal is an
  // answered-call contact tag.
  const leads = [
    opp("contact-stratco", null, {
      contact: { id: "c-stratco", name: "Lead A" },
    }),
    opp("contact-normal", null, {
      source: "",
      contact: { id: "c-normal", name: "Lead B" },
    }),
  ];
  const facts: Record<string, SalesBookingContactFact> = {
    "c-stratco": { tags: ["stratco"] },
    "c-normal": { tags: ["answered-call"] },
  };
  let asked: string[] = [];
  const readContacts: SalesBookingReadDependencies["readContacts"] = (
    ids,
  ) => {
    asked.push(...ids);
    return Promise.resolve(
      Object.fromEntries(ids.map((id) => [id, facts[id]])),
    );
  };
  const read = async (resource: string) => {
    asked = [];
    return await salesBookingRead(readDeps(leads, { readContacts }), {
      resource,
      week_start: WEEK,
    });
  };
  const marnin = await read("marnin");
  assertEquals(marnin.cases.map((row) => [row.id, row.owner_unclear]), [
    ["contact-stratco", undefined],
  ]);
  const khairo = await read("khairo");
  assertEquals(khairo.cases.map((row) => [row.id, row.tags]), [
    ["contact-normal", ["answered-call"]],
  ]);
  // Each contact is read once: the kind read is reused to hydrate the row.
  assertEquals(asked.sort(), ["c-normal", "c-stratco"]);
});

Deno.test("read: an owner-unclear lead booked on the STRATCO FENCING calendar is Marnin's Stratco lead, as at approval", async () => {
  const leads = [opp("unclear-booked", null, { source: "" })];
  const deps = readDeps(leads, {
    readContactStratcoBooked: () => Promise.resolve(true),
  });
  const marnin = await salesBookingRead(deps, {
    resource: "marnin",
    week_start: WEEK,
  });
  assertEquals(marnin.cases.map((row) => [row.id, row.owner_unclear]), [
    ["unclear-booked", undefined],
  ]);
  assertEquals(
    (await salesBookingRead(deps, { resource: "khairo", week_start: WEEK }))
      .cases,
    [],
  );
});

Deno.test("lead kind resolver: contact and calendar are read together; a failed read never clears a lead for the normal line", async () => {
  const lead = (source: string) => ({
    id: "opp-1",
    source,
    contact: { id: "c-1", name: "Lead" },
  });
  const contact = (fact: SalesBookingContactFact | null) => () =>
    fact ? Promise.resolve({ "c-1": fact }) : Promise.reject(new Error("500"));
  const calendar = (booked: boolean | null) => () =>
    booked === null
      ? Promise.reject(new Error("500"))
      : Promise.resolve(booked);
  const resolve = async (
    source: string,
    fact: SalesBookingContactFact | null,
    booked: boolean | null,
  ) => {
    const { kind, kindUnread } = await resolveSalesBookingLeadKind(
      lead(source),
      { readContacts: contact(fact), readStratcoBooked: calendar(booked) },
    );
    return [kind, kindUnread];
  };
  assertEquals(await resolve("Website Enquiry", {}, false), ["normal", false]);
  assertEquals(await resolve("", { tags: ["web - enquiry"] }, false), [
    "normal",
    false,
  ]);
  assertEquals(await resolve("", {}, false), ["unclear", false]);
  assertEquals(await resolve("Website Enquiry", { tags: ["Stratco"] }, null), [
    "stratco",
    false,
  ]);
  assertEquals(
    await resolve("Website Enquiry", { source: "Stratco allocation" }, false),
    ["stratco", false],
  );
  assertEquals(await resolve("Website Enquiry", null, true), [
    "stratco",
    false,
  ]);
  assertEquals(await resolve("Website Enquiry", null, false), [
    "unclear",
    true,
  ]);
  assertEquals(await resolve("Website Enquiry", {}, null), [
    "unclear",
    true,
  ]);
  assertEquals(
    await resolveSalesBookingLeadKind(lead("Website Enquiry"), {}),
    { kind: "unclear", kindUnread: true, contact: null },
  );

  // A Stratco lead on its face needs no reads.
  let reads = 0;
  const counted = {
    readContacts: () => (reads++, Promise.resolve({})),
    readStratcoBooked: () => (reads++, Promise.resolve(false)),
  };
  assertEquals(
    (await resolveSalesBookingLeadKind(lead("Stratco"), counted)).kind,
    "stratco",
  );
  assertEquals(reads, 0);

  // The contact read only answers once the calendar read has started.
  let calendarAsked!: () => void;
  const started = new Promise<void>((resolve) => calendarAsked = resolve);
  const together = await resolveSalesBookingLeadKind(lead("Website Enquiry"), {
    readContacts: async () => {
      await started;
      return { "c-1": {} };
    },
    readStratcoBooked: () => {
      calendarAsked();
      return Promise.resolve(false);
    },
  });
  assertEquals(together.kind, "normal");
});

Deno.test("approval ownership read: a contact tag makes an unassigned lead Stratco, and an unread STRATCO calendar holds it owner unclear instead of failing", async () => {
  const env = ["GHL_API_TOKEN", "GHL_LOCATION_ID"].map((
    name,
  ) => [name, Deno.env.get(name)] as const);
  const realFetch = globalThis.fetch;
  let contactTags: string[] = [];
  let calendarStatus = 200;
  try {
    Deno.env.set("GHL_API_TOKEN", "test-token");
    Deno.env.set("GHL_LOCATION_ID", "loc-1");
    globalThis.fetch = ((input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const json = (status: number, body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (path === "/opportunities/opp-1") {
        return json(200, {
          opportunity: {
            id: "opp-1",
            locationId: "loc-1",
            assignedTo: null,
            pipelineId: FENCING,
            source: "Website Enquiry",
            contact: { id: "c-1", name: "Lead" },
          },
        });
      }
      if (path === "/contacts/c-1") {
        return json(200, { contact: { id: "c-1", tags: contactTags } });
      }
      if (path === "/contacts/c-1/appointments") {
        return json(calendarStatus, { events: [] });
      }
      return json(404, {});
    }) as typeof fetch;
    const read = () => readSalesBookingOpportunityOwnership("opp-1");
    assertEquals(await read(), {
      assignedTo: null,
      pipelineId: FENCING,
      kind: "normal",
      kindUnread: false,
    });
    contactTags = ["stratco"];
    calendarStatus = 500;
    assertEquals((await read()).kind, "stratco");
    contactTags = [];
    const held = await read();
    assertEquals([held.kind, held.kindUnread], ["unclear", true]);
    assertEquals(salesBookingLeadBelongsTo(held, "khairo"), "no");
    assertEquals(salesBookingLeadBelongsTo(held, "marnin"), "owner_unclear");
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of env) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("read: a cached lead's live ownership recheck uses the same rule", async () => {
  // Roster from cache: every candidate is re-read live, so the recheck's own
  // classification decides an unassigned lead.
  const kinds = new Map<string, SalesBookingLeadKind>([
    ["a", "stratco"],
    ["b", "normal"],
    ["c", "unclear"],
    ["d", "unclear"],
  ]);
  const cachedDeps = () =>
    readDeps([], {
      loadRosterCache: () =>
        Promise.resolve({
          read_at: new Date(NOW.getTime() - 60_000).toISOString(),
          opportunities: [
            opp("a", null),
            opp("b", null),
            opp("c", null),
            opp("d", null),
          ],
          stages: { [STAGE]: "New Lead" },
          exhausted: true,
          pages_scanned: 1,
          total: 4,
          reason: null,
          next_start_after: null,
          next_start_after_id: null,
        } as never),
      // "d": its contact or STRATCO calendar could not be read; the live
      // path holds such a lead the same way.
      readOpportunityOwnership: (id) =>
        Promise.resolve({
          assignedTo: null,
          pipelineId: FENCING,
          kind: kinds.get(id) ?? "unclear",
          kindUnread: id === "d",
        }),
    });
  const read = (resource: string) =>
    salesBookingRead(cachedDeps(), { resource, week_start: WEEK });
  const sorted = (cases: { id: string; owner_unclear?: boolean }[]) =>
    cases.sort((x, y) => x.id.localeCompare(y.id));
  const marnin = await read("marnin");
  assertEquals(
    sorted(marnin.cases).map((row) => [row.id, row.owner_unclear ?? false]),
    [["a", false], ["c", true], ["d", true]],
  );
  assert(
    marnin.coverage.gaps.some((gap) =>
      gap.includes("1 unassigned fencing lead(s) held as owner unclear")
    ),
  );
  const khairo = await read("khairo");
  assertEquals(sorted(khairo.cases).map((row) => row.id), ["b"]);
  assertEquals(khairo.coverage.full_population, false);
});

Deno.test("approval: the live ownership check uses the same rule", async () => {
  const read = (assignedTo: string | null, kind: SalesBookingLeadKind) => () =>
    Promise.resolve({ assignedTo, pipelineId: FENCING, kind });
  await assertLeadBelongsToResource(read(null, "normal"), "opp-1", "khairo");
  await assertLeadBelongsToResource(read(null, "stratco"), "opp-1", "marnin");
  await assertLeadBelongsToResource(read(MARNIN, "normal"), "opp-1", "marnin");
  await assertLeadBelongsToResource(read(KHAIRO, "unclear"), "opp-1", "khairo");
  await assertRejects(
    () => assertLeadBelongsToResource(read(null, "normal"), "opp-1", "marnin"),
    Error,
    "lead_assigned_to_someone_else",
  );
  await assertRejects(
    () =>
      assertLeadBelongsToResource(read(MARNIN, "normal"), "opp-1", "khairo"),
    Error,
    "lead_assigned_to_someone_else",
  );
  await assertRejects(
    () => assertLeadBelongsToResource(read(null, "unclear"), "opp-1", "marnin"),
    Error,
    "owner_unclear",
  );
  await assertRejects(
    () => assertLeadBelongsToResource(read(null, "unclear"), "opp-1", "khairo"),
    Error,
    "lead_assigned_to_someone_else",
  );
});

Deno.test("booked elsewhere: Basil on Khairo's calendar Tue 29 Sep 10:00 is booked with Khairo", () => {
  const reads: SalesBookingScopeCalendarRead[] = [
    { resource_id: "marnin", read_ok: true, reason: null, events: [] },
    {
      resource_id: "khairo",
      read_ok: true,
      reason: null,
      events: [BASIL_VISIT],
    },
    { resource_id: "nithin", read_ok: true, reason: null, events: [] },
  ];
  const cases: Array<
    { contact_id: string | null; scope_appointment?: unknown }
  > = [{ contact_id: BASIL_CONTACT }, { contact_id: "someone-else" }];
  const result = applySalesBookingScopeAppointments(
    cases as never,
    reads,
    NOW.getTime(),
  );
  const booked = {
    start_iso: "2026-09-29T10:00:00+08:00",
    end_iso: "2026-09-29T10:30:00+08:00",
    owner_name: "Khairo",
    owner_resource_id: "khairo",
    status: "confirmed",
    event_id: "0iuacuMRFkRAaKt8dGPt",
  };
  assertEquals(cases[0].scope_appointment, booked);
  assertEquals(cases[1].scope_appointment, null);
  assertEquals(result.by_contact, { [BASIL_CONTACT]: booked });
  assertEquals(result.gaps, []);
});

Deno.test("booked elsewhere: cancelled, no-show, deleted and past visits are not bookings; an unread calendar is a named gap", () => {
  const events = [
    { ...BASIL_VISIT, id: "c", appointmentStatus: "cancelled" },
    { ...BASIL_VISIT, id: "n", appointmentStatus: "noshow" },
    { ...BASIL_VISIT, id: "d", deleted: true },
    {
      ...BASIL_VISIT,
      id: "p",
      startTime: "2026-09-22T10:00:00+08:00",
      endTime: "2026-09-22T10:30:00+08:00",
    },
  ];
  const cases = [{ contact_id: BASIL_CONTACT } as {
    contact_id: string | null;
    scope_appointment?: unknown;
  }];
  const result = applySalesBookingScopeAppointments(
    cases as never,
    [
      { resource_id: "khairo", read_ok: true, reason: null, events },
      {
        resource_id: "marnin",
        read_ok: false,
        reason: "GHL 500",
        events: [BASIL_VISIT],
      },
    ],
    NOW.getTime(),
  );
  assertEquals(cases[0].scope_appointment, null);
  assertEquals(result.gaps.length, 1);
  assert(result.gaps[0].includes("Marnin Stobbe's GHL calendar unread"));
});

Deno.test("proof: Basil booked on Khairo's calendar is off Marnin's to-contact list, shown as booked with Khairo", async () => {
  const calendars = new Map([[KHAIRO, [BASIL_VISIT]]]);
  const readScopeCalendar: SalesBookingReadDependencies["readScopeCalendar"] = (
    { ghlUserId },
  ) =>
    Promise.resolve({ events: calendars.get(ghlUserId) ?? [], failure: null });

  // On Marnin's own list (e.g. a Stratco lead of his): the row carries the
  // booking, so the screen files it under Booked, not To contact.
  const onList = await salesBookingRead(
    readDeps([
      opp("basil", null, {
        source: "Stratco lead allocation",
        contact: { id: BASIL_CONTACT, name: "Basil L", tags: [] },
      }),
      opp("other", MARNIN),
    ], { readScopeCalendar }),
    { resource: "marnin", week_start: WEEK },
  );
  const basil = onList.cases.find((row) => row.id === "basil")!;
  assertEquals(basil.scope_appointment?.owner_resource_id, "khairo");
  assertEquals(basil.scope_appointment?.owner_name, "Khairo");
  assertEquals(
    basil.scope_appointment?.start_iso,
    "2026-09-29T10:00:00+08:00",
  );
  assertEquals(
    onList.cases.find((row) => row.id === "other")!.scope_appointment,
    null,
  );

  // Live shape: Basil's GHL lead is Khairo's, so he is not on Marnin's roster
  // list at all; the engine pack still offers him a Marnin time. The pack
  // offer becomes a booked-with-Khairo row, never a to-contact row.
  const read = await salesBookingRead(
    readDeps([opp("other", MARNIN)], { readScopeCalendar }),
    { resource: "marnin", week_start: WEEK },
  );
  assertEquals(read.cases.map((row) => row.id), ["other"]);
  const withPack = applySalesBookingPackOverlay(read, {
    pack: {
      id: "pack-1",
      as_of: NOW.toISOString(),
      payload: {
        proposals: {
          profile: "fencing-stratco-marnin",
          leads: [{
            id: "opp:9XZmlVHcsQ0F8ExT3Smz",
            opportunity_id: "9XZmlVHcsQ0F8ExT3Smz",
            contact_id: BASIL_CONTACT,
            name: "Basil L",
            suburb: "Aubin Grove",
            disposition: "offer",
            window: {
              day: "Fri",
              start: "2026-10-02T12:00:00+08:00",
              end: "2026-10-02T13:30:00+08:00",
            },
            draft: "Hi Basil, can we come out Friday?",
          }, {
            id: "opp:not-booked",
            opportunity_id: "not-booked",
            contact_id: "contact-not-booked",
            name: "Priya S",
            disposition: "offer",
          }],
        },
      },
    } as never,
    stamp: null,
    pack_error: null,
    stamp_error: null,
  });
  const row = withPack.cases.find((c) =>
    c.opportunity_id === "9XZmlVHcsQ0F8ExT3Smz"
  )!;
  assertEquals(row.scope_appointment?.owner_resource_id, "khairo");
  assertEquals(row.display_name, "Basil L");
  assertEquals(row.suburb, "Aubin Grove");
  assertEquals(row.proposal, null);
  // A pack offer with no booking is left for the screen as before.
  assertEquals(
    withPack.cases.some((c) => c.opportunity_id === "not-booked"),
    false,
  );
  assertEquals(
    withPack.scope_appointments?.[BASIL_CONTACT]?.owner_name,
    "Khairo",
  );

  // The live availability layer (applied after the read) keeps the flag.
  const live = await applySalesBookingAvailability(withPack, {
    readGhlDirectory: () =>
      Promise.resolve({
        calendars: [{
          id: "dEQKVKHthsjSYaen1fiE",
          is_active: true,
          assigned_user_ids: [MARNIN],
          assignments_returned: true,
        }],
        users: [{ id: MARNIN, email: "marnin@secureworkswa.com.au" }],
      }),
    readGhlEvents: () => Promise.resolve([]),
    readGhlBlockedSlots: () => Promise.resolve([]),
    readSystemOfferRecords: () =>
      Promise.resolve({ executions: [], approvals: [] }),
    now: () => NOW,
  });
  const liveRow = live.cases.find((c) =>
    c.opportunity_id === "9XZmlVHcsQ0F8ExT3Smz"
  )!;
  assertEquals(liveRow.scope_appointment, row.scope_appointment);
  assertEquals(
    live.scope_appointments?.[BASIL_CONTACT]?.owner_name,
    "Khairo",
  );
  assertEquals(
    live.cases.map((c) => c.opportunity_id),
    withPack.cases.map((c) => c.opportunity_id),
  );
});
