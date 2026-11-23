// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bookRestorationVisit,
  restorationVisitEndTime,
  restorationVisitRowsToDate,
  RestorationVisitRefusal,
} from "./restoration_visit_booking.ts";
import { RESTORATION_INTAKE_ASSIGNMENT_NOTE } from "./restoration_intake_inspection.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ORG = "00000000-0000-0000-0000-000000000001";
const JEAN = "33333333-3333-4333-8333-333333333333";
const MARNIN = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

const RESTO_JOB = {
  id: JOB_ID,
  org_id: ORG,
  job_number: "SWRESTO-260001",
  type: "makesafe",
  metadata: { makesafe_job_family: "restoration" },
};

function intakeRow(id: string, user: string, extra: any = {}) {
  return {
    id,
    job_id: JOB_ID,
    user_id: user,
    status: "scheduled",
    role: "lead_installer",
    is_ghost: false,
    scheduled_date: null,
    notes: RESTORATION_INTAKE_ASSIGNMENT_NOTE,
    ...extra,
  };
}

function fake(job: any, rows: any[]) {
  const events: any[] = [];
  const client = {
    events,
    from(table: string) {
      const q: any = {
        select() { return q; },
        eq() { return q; },
        maybeSingle() { return Promise.resolve({ data: table === "jobs" ? job : null, error: null }); },
        insert(row: any) { events.push(row); return Promise.resolve({ error: null }); },
        then(resolve: any) { return resolve({ data: table === "job_assignments" ? rows : [], error: null }); },
      };
      return q;
    },
  };
  return client;
}

function deps(today = "2026-11-20") {
  const updates: any[] = [];
  return {
    updates,
    deps: {
      today,
      updateAssignment: (b: any) => {
        updates.push(b);
        return Promise.resolve({ assignment: { scheduled_date: b.scheduledDate } });
      },
    },
  };
}

const TRADE = { id: JEAN, orgId: ORG, name: "Jean Crous" };

Deno.test("end time is the start plus two hours", () => {
  assertEquals(restorationVisitEndTime("07:30"), "09:30");
  assertEquals(restorationVisitEndTime("23:00"), "23:59");
  assertEquals(restorationVisitEndTime("7am"), null);
});

Deno.test("rows to date: the caller's undated row and the intake's undated rows only", () => {
  const rows = [
    intakeRow("a", JEAN),
    intakeRow("b", MARNIN),
    intakeRow("c", OTHER, { notes: "booked by office" }),
    intakeRow("d", MARNIN, { scheduled_date: "2026-11-22" }),
    intakeRow("e", MARNIN, { status: "cancelled" }),
    intakeRow("f", OTHER, { is_ghost: true }),
  ];
  assertEquals(restorationVisitRowsToDate(rows, JEAN).map((r) => r.id), ["a", "b"]);
});

Deno.test("Jean books the visit: his row and Marnin's are dated, confirmed, one event", async () => {
  const client = fake(RESTO_JOB, [intakeRow("a", JEAN), intakeRow("b", MARNIN)]);
  const { updates, deps: d } = deps();
  const out: any = await bookRestorationVisit(client, {
    body: { job_id: JOB_ID, date: "2026-11-24", start_time: "08:00" },
    trade: TRADE,
  }, d);
  assertEquals(out.ok, true);
  assertEquals(updates.map((u) => u.assignmentId), ["a", "b"]);
  assertEquals(updates[0].scheduledDate, "2026-11-24");
  assertEquals(updates[0].startTime, "08:00");
  assertEquals(updates[0].endTime, "10:00");
  assertEquals(updates[0].confirmation_status, "confirmed");
  assertEquals(client.events.length, 1);
  assertEquals(client.events[0].event_type, "restoration_visit_booked");
});

Deno.test("a booked visit is not moved again by the trade", async () => {
  const client = fake(RESTO_JOB, [intakeRow("a", JEAN, { scheduled_date: "2026-11-24" })]);
  const { updates, deps: d } = deps();
  const err = await assertRejects(
    () => bookRestorationVisit(client, { body: { job_id: JOB_ID, date: "2026-11-25" }, trade: TRADE }, d),
    RestorationVisitRefusal,
  );
  assertEquals((err as RestorationVisitRefusal).code, "already_booked");
  assertEquals(updates.length, 0);
});

Deno.test("refusals: not on the job, not restoration, past date, too far, other company", async () => {
  const cases: Array<[any, any[], any, string, any?]> = [
    [RESTO_JOB, [intakeRow("b", MARNIN)], { job_id: JOB_ID, date: "2026-11-24" }, "not_on_job"],
    [{ ...RESTO_JOB, metadata: {} }, [intakeRow("a", JEAN)], { job_id: JOB_ID, date: "2026-11-24" }, "not_a_restoration_job"],
    [RESTO_JOB, [intakeRow("a", JEAN)], { job_id: JOB_ID, date: "2026-11-19" }, "date_in_past"],
    [RESTO_JOB, [intakeRow("a", JEAN)], { job_id: JOB_ID, date: "2027-06-01" }, "date_too_far"],
    [RESTO_JOB, [intakeRow("a", JEAN)], { job_id: JOB_ID, date: "2026-11-24", start_time: "8am" }, "start_time_invalid"],
    [{ ...RESTO_JOB, org_id: OTHER }, [intakeRow("a", JEAN)], { job_id: JOB_ID, date: "2026-11-24" }, "job_not_found"],
  ];
  for (const [job, rows, body, code] of cases) {
    const { updates, deps: d } = deps();
    const err = await assertRejects(
      () => bookRestorationVisit(fake(job, rows), { body, trade: TRADE }, d),
      RestorationVisitRefusal,
    );
    assertEquals((err as RestorationVisitRefusal).code, code);
    assertEquals(updates.length, 0);
  }
});

Deno.test("today is allowed", async () => {
  const client = fake(RESTO_JOB, [intakeRow("a", JEAN)]);
  const { updates, deps: d } = deps();
  const out: any = await bookRestorationVisit(client, { body: { job_id: JOB_ID, date: "2026-11-20" }, trade: TRADE }, d);
  assert(out.ok);
  assertEquals(updates[0].startTime, undefined);
});
