// deno-lint-ignore-file no-import-prefix
// Owner 2026-09-24: "khairo is all normal fencing all stratco fencing is
// mine." Unassigned Stratco fencing is Marnin's, other unassigned fencing is
// Khairo's, unassigned patio is Nithin's, and an explicit GHL assignee always
// wins. A lead already booked with a scoper shows as booked with them and
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
  salesBookingLeadIsStratco,
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

Deno.test("Stratco is read from a tag, the name or the source, as the Stratco profile matches", () => {
  assert(salesBookingLeadIsStratco({ contact: { tags: ["Stratco"] } }));
  assert(salesBookingLeadIsStratco({ tags: ["stratco lead"] }));
  assert(salesBookingLeadIsStratco({ name: "Sonia Stratco 231030" }));
  assert(salesBookingLeadIsStratco({ contact: { name: "Sonia Stratco" } }));
  assert(salesBookingLeadIsStratco({ source: "Stratco lead allocation" }));
  // A plain website fencing enquiry (live shape, 23 Sep) is not Stratco.
  assertEquals(
    salesBookingLeadIsStratco({
      name: "Bec",
      source: "Website Enquiry",
      contact: { tags: ["source:organic", "web - enquiry", "sw fencing"] },
    }),
    false,
  );
  assertEquals(salesBookingLeadIsStratco(null), false);
});

Deno.test("whose lead: the explicit assignee wins; unassigned is Stratco Marnin, other fencing Khairo, patio Nithin", () => {
  const owners = (
    assignedTo: string | null,
    pipelineId: string,
    stratco: boolean,
  ) =>
    Object.keys(SALES_BOOKING_RESOURCES).filter((resource) =>
      salesBookingLeadBelongsTo(assignedTo, resource, pipelineId, stratco)
    );
  assertEquals(owners(null, FENCING, true), ["marnin"]);
  assertEquals(owners(null, FENCING, false), ["khairo"]);
  assertEquals(owners(null, PATIO, false), ["nithin"]);
  assertEquals(owners(null, PATIO, true), ["nithin"]);
  // Explicit assignee overrides the rule in both directions.
  assertEquals(owners(MARNIN, FENCING, false), ["marnin"]);
  assertEquals(owners(KHAIRO, FENCING, true), ["khairo"]);
  assertEquals(owners(NITHIN, FENCING, true), ["nithin"]);
  // Someone who is not a booking person: nobody's here.
  assertEquals(owners("someone-else", FENCING, true), []);
});

Deno.test("read: each person's list follows the rule, over the same fencing pipeline", async () => {
  const leads = [
    opp("stratco-unassigned", null, { source: "Stratco lead allocation" }),
    opp("plain-unassigned", null),
    opp("plain-assigned-marnin", MARNIN),
    opp("stratco-assigned-khairo", KHAIRO, { name: "Stratco lead" }),
  ];
  const listed = async (resource: string) =>
    (await salesBookingRead(readDeps(leads), {
      resource,
      week_start: WEEK,
    })).cases.map((row) => row.id).sort();
  assertEquals(await listed("marnin"), [
    "plain-assigned-marnin",
    "stratco-unassigned",
  ]);
  assertEquals(await listed("khairo"), [
    "plain-unassigned",
    "stratco-assigned-khairo",
  ]);
});

Deno.test("read: a cached lead's live ownership recheck uses the same rule", async () => {
  // Roster from cache: every candidate is re-read live, so the recheck's own
  // Stratco signal decides an unassigned lead.
  const stratco = new Map([["a", true], ["b", false]]);
  const cachedDeps = () =>
    readDeps([], {
      loadRosterCache: () =>
        Promise.resolve({
          read_at: new Date(NOW.getTime() - 60_000).toISOString(),
          opportunities: [opp("a", null), opp("b", null)],
          stages: { [STAGE]: "New Lead" },
          exhausted: true,
          pages_scanned: 1,
          total: 2,
          reason: null,
          next_start_after: null,
          next_start_after_id: null,
        } as never),
      readOpportunityOwnership: (id) =>
        Promise.resolve({
          assignedTo: null,
          pipelineId: FENCING,
          stratco: stratco.get(id) ?? false,
        }),
    });
  const ids = async (resource: string) =>
    (await salesBookingRead(cachedDeps(), {
      resource,
      week_start: WEEK,
    })).cases.map((row) => row.id);
  assertEquals(await ids("marnin"), ["a"]);
  assertEquals(await ids("khairo"), ["b"]);
});

Deno.test("approval: the live ownership check uses the same rule", async () => {
  const read = (assignedTo: string | null, stratco: boolean) => () =>
    Promise.resolve({ assignedTo, pipelineId: FENCING, stratco });
  await assertLeadBelongsToResource(read(null, false), "opp-1", "khairo");
  await assertLeadBelongsToResource(read(null, true), "opp-1", "marnin");
  await assertLeadBelongsToResource(read(MARNIN, false), "opp-1", "marnin");
  await assertRejects(
    () => assertLeadBelongsToResource(read(null, false), "opp-1", "marnin"),
    Error,
    "lead_assigned_to_someone_else",
  );
  await assertRejects(
    () => assertLeadBelongsToResource(read(MARNIN, false), "opp-1", "khairo"),
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
