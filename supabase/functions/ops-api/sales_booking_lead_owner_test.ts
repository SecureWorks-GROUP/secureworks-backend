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
  SALES_BOOKING_RESOURCES,
  salesBookingLeadBelongsTo,
  type SalesBookingMessage,
  salesBookingRead,
  type SalesBookingReadDependencies,
} from "./sales_booking_read.ts";
import {
  SALES_BOOKING_SENDER_LINES,
  SALES_BOOKING_STRATCO_CALENDAR_ID,
  type SalesBookingLeadKind,
  salesBookingLeadKind,
} from "./sales_booking_sender.ts";
import { assertLeadBelongsToResource } from "./sales_booking_confirmation.ts";
import { applySalesBookingPackOverlay } from "./sales_booking_pack.ts";
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

Deno.test("read: a normal lead booked on the STRATCO FENCING calendar is Marnin's, not Khairo's", async () => {
  const leads = [opp("booked-stratco", null)];
  const readScopeCalendar: SalesBookingReadDependencies["readScopeCalendar"] = (
    { ghlUserId },
  ) =>
    Promise.resolve({
      events: ghlUserId === MARNIN
        ? [{
          ...BASIL_VISIT,
          id: "stratco-visit",
          assignedUserId: MARNIN,
          calendarId: SALES_BOOKING_STRATCO_CALENDAR_ID,
          contactId: "contact-booked-stratco",
        }]
        : [],
      failure: null,
    });
  const ids = async (resource: string) =>
    (await salesBookingRead(readDeps(leads, { readScopeCalendar }), {
      resource,
      week_start: WEEK,
    })).cases.map((row) => row.id);
  assertEquals(await ids("marnin"), ["booked-stratco"]);
  assertEquals(await ids("khairo"), []);
});

Deno.test("read: a cached lead's live ownership recheck uses the same rule", async () => {
  // Roster from cache: every candidate is re-read live, so the recheck's own
  // classification decides an unassigned lead.
  const kinds = new Map<string, SalesBookingLeadKind>([
    ["a", "stratco"],
    ["b", "normal"],
    ["c", "unclear"],
  ]);
  const cachedDeps = () =>
    readDeps([], {
      loadRosterCache: () =>
        Promise.resolve({
          read_at: new Date(NOW.getTime() - 60_000).toISOString(),
          opportunities: [opp("a", null), opp("b", null), opp("c", null)],
          stages: { [STAGE]: "New Lead" },
          exhausted: true,
          pages_scanned: 1,
          total: 3,
          reason: null,
          next_start_after: null,
          next_start_after_id: null,
        } as never),
      readOpportunityOwnership: (id) =>
        Promise.resolve({
          assignedTo: null,
          pipelineId: FENCING,
          kind: kinds.get(id) ?? "unclear",
        }),
    });
  const read = async (resource: string) =>
    (await salesBookingRead(cachedDeps(), {
      resource,
      week_start: WEEK,
    })).cases.sort((x, y) => x.id.localeCompare(y.id));
  const marnin = await read("marnin");
  assertEquals(marnin.map((row) => row.id), ["a", "c"]);
  assertEquals(marnin.map((row) => row.owner_unclear ?? false), [false, true]);
  assertEquals((await read("khairo")).map((row) => row.id), ["b"]);
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
});
