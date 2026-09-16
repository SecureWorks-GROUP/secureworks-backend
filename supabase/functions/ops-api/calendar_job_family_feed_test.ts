// deno-lint-ignore-file no-explicit-any
// Calendar feed job_family contract.
// ---------------------------------------------------------------------------
// The OpsDash calendar's Divisions filter classes an event by job_type, which
// mirrors jobs.type. A family-tagged repair (`jobs.metadata.ses_family =
// 'repair'`, jobs.type deliberately never retyped) therefore filed under its
// birth division. The fix exposes `calendar_events.job_family` and threads it
// through the real `calendarEvents` action and the `ops_summary` schedule
// mapper, so the dashboard can apply: 'repair' => Repair division regardless
// of job_type; null/other => fall back to job_type.
//
// This drives the REAL exported calendarEvents with a fake PostgREST client
// (same shape as calendar_scope_oom_test.ts) and asserts on observable
// behaviour: the column is requested from the view on BOTH select branches,
// and the value the view serves reaches the response event untouched.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calendarEvents,
  OPS_SUMMARY_SCHEDULE_COLUMNS,
  toOpsSummaryScheduleEvent,
} from "./index.ts";

function calClient(calRows: any[]) {
  const captured: { selects: Record<string, string> } = { selects: {} };
  function builder(table: string) {
    const b: any = {
      select: (s: string) => {
        captured.selects[table] = s;
        return b;
      },
      or: () => b,
      lte: () => b,
      gte: () => b,
      eq: () => b,
      neq: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      then: (res: any, rej: any) =>
        Promise.resolve({
          data: table === "calendar_events" ? calRows : [],
          error: null,
        }).then(res, rej),
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, captured };
}

const params = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ from: "2026-09-14", to: "2026-09-20", ...extra });

// Three rows mirroring the live population that motivated the change:
// a make-safe card family-tagged repair, a fencing card family-tagged repair,
// and a plain make-safe with no family at all.
const ROWS = [
  {
    assignment_id: "asg-makesafe-repair",
    job_id: "job-261319",
    job_number: "SWMS-261319",
    job_type: "makesafe",
    job_family: "repair",
    scheduled_date: "2026-09-16",
    assignment_status: "scheduled",
    org_id: "org-1",
  },
  {
    assignment_id: "asg-fencing-repair",
    job_id: "job-261343",
    job_number: "SWF-261343",
    job_type: "fencing",
    job_family: "repair",
    scheduled_date: "2026-09-17",
    assignment_status: "scheduled",
    org_id: "org-1",
  },
  {
    assignment_id: "asg-plain-makesafe",
    job_id: "job-plain",
    job_number: "SWMS-PLAIN",
    job_type: "makesafe",
    job_family: null,
    scheduled_date: "2026-09-18",
    assignment_status: "scheduled",
    org_id: "org-1",
  },
];

function selectsColumn(sel: string, column: string) {
  return sel.split(",").map((s) => s.trim()).includes(column);
}

Deno.test("calendar light feed requests job_family from the view and serves it per event", async () => {
  const { client, captured } = calClient(ROWS);
  const res: any = await calendarEvents(client, params());
  const sel = captured.selects["calendar_events"];
  assert(sel, "calendar_events was queried");
  assert(
    selectsColumn(sel, "job_family"),
    `light select must name job_family: ${sel}`,
  );
  assert(
    selectsColumn(sel, "job_type"),
    "job_type is still served beside job_family",
  );

  const byAssignment = Object.fromEntries(
    res.events.map((e: any) => [e.assignment_id, e]),
  );
  assertEquals(byAssignment["asg-makesafe-repair"].job_family, "repair");
  assertEquals(byAssignment["asg-makesafe-repair"].job_type, "makesafe");
  assertEquals(byAssignment["asg-fencing-repair"].job_family, "repair");
  assertEquals(byAssignment["asg-fencing-repair"].job_type, "fencing");
  // The consumer contract: null means fall back to job_type. The key must be
  // PRESENT (not stripped) so the dashboard can distinguish "no family" from
  // "field not served".
  assert("job_family" in byAssignment["asg-plain-makesafe"]);
  assertEquals(byAssignment["asg-plain-makesafe"].job_family, null);
  assertEquals(byAssignment["asg-plain-makesafe"].job_type, "makesafe");
});

Deno.test("calendar include_financials feed also requests and serves job_family", async () => {
  const { client, captured } = calClient(ROWS);
  const res: any = await calendarEvents(
    client,
    params({ include_financials: "true" }),
  );
  const sel = captured.selects["calendar_events"];
  assert(
    selectsColumn(sel, "job_family"),
    `financial select must name job_family: ${sel}`,
  );
  const repair = res.events.find((e: any) =>
    e.assignment_id === "asg-fencing-repair"
  );
  assertEquals(repair.job_family, "repair");
  assertEquals(repair.job_type, "fencing");
});

Deno.test("calendar feed never widens to the metadata blob to carry the family", async () => {
  for (
    const extra of [{}, { include_financials: "true" }] as Record<
      string,
      string
    >[]
  ) {
    const { client, captured } = calClient([]);
    await calendarEvents(client, params(extra));
    const sel = captured.selects["calendar_events"];
    assert(!/metadata/.test(sel), `select must not read jobs.metadata: ${sel}`);
  }
});

Deno.test("ops_summary today_schedule carries job_family through its mapper", () => {
  assert(
    OPS_SUMMARY_SCHEDULE_COLUMNS.split(", ").includes("job_family"),
    "ops_summary schedule projection selects job_family",
  );
  const mapped = toOpsSummaryScheduleEvent({
    assignment_id: "asg-1",
    job_id: "job-261163",
    job_type: "makesafe",
    job_family: "repair",
    assignment_status: "scheduled",
    job_status: "processing",
  });
  assertEquals(mapped.job_family, "repair");
  assertEquals(mapped.job_type, "makesafe");
  const plain = toOpsSummaryScheduleEvent({
    job_type: "makesafe",
    job_family: null,
  });
  assert("job_family" in plain);
  assertEquals(plain.job_family, null);
});
