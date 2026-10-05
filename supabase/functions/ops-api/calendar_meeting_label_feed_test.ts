// deno-lint-ignore-file no-explicit-any
// Calendar light feed: job-less entry label contract.
// ---------------------------------------------------------------------------
// The OpsDash calendar calls the `calendar` action WITHOUT include_financials,
// so it gets CAL_LIGHT_COLUMNS. That list dropped `label` and
// `recurrence_group_id` when the feed was enumerated (cace231a), so every
// meeting rendered as "Internal" and the Schedule view (which groups job-less
// entries by label + date) merged two same-day meetings into one bar.
//
// Drives the REAL exported calendarEvents with a fake PostgREST client (same
// shape as calendar_job_family_feed_test.ts) and asserts the light select names
// both columns and the values reach the response events.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calendarEvents } from "./index.ts";

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
  new URLSearchParams({ from: "2026-10-05", to: "2026-10-11", ...extra });

// Two job-less meetings on the same Monday, each its own weekly series.
const ROWS = [
  {
    assignment_id: "asg-insurance",
    job_id: null,
    assignment_type: "meeting",
    label: "Insurance Meeting - Shaun, Hugo",
    recurrence_group_id: "grp-insurance",
    scheduled_date: "2026-10-05",
    start_time: "12:00:00",
    assignment_status: "scheduled",
    org_id: "org-1",
  },
  {
    assignment_id: "asg-patio",
    job_id: null,
    assignment_type: "meeting",
    label: "Patio Meeting - Shaun, Nithin",
    recurrence_group_id: "grp-patio",
    scheduled_date: "2026-10-05",
    start_time: "13:00:00",
    assignment_status: "scheduled",
    org_id: "org-1",
  },
];

function selectsColumn(sel: string, column: string) {
  return sel.split(",").map((s) => s.trim()).includes(column);
}

Deno.test("calendar light feed requests label + recurrence_group_id and serves them per event", async () => {
  const { client, captured } = calClient(ROWS);
  const res: any = await calendarEvents(client, params());
  const sel = captured.selects["calendar_events"];
  assert(sel, "calendar_events was queried");
  assert(selectsColumn(sel, "label"), `light select must name label: ${sel}`);
  assert(
    selectsColumn(sel, "recurrence_group_id"),
    `light select must name recurrence_group_id: ${sel}`,
  );

  const byAssignment = Object.fromEntries(
    res.events.map((e: any) => [e.assignment_id, e]),
  );
  assertEquals(byAssignment["asg-insurance"].label, "Insurance Meeting - Shaun, Hugo");
  assertEquals(byAssignment["asg-patio"].label, "Patio Meeting - Shaun, Nithin");
  assertEquals(byAssignment["asg-patio"].recurrence_group_id, "grp-patio");
});

Deno.test("calendar include_financials feed still requests label + recurrence_group_id", async () => {
  const { client, captured } = calClient(ROWS);
  await calendarEvents(client, params({ include_financials: "true" }));
  const sel = captured.selects["calendar_events"];
  assert(selectsColumn(sel, "label"));
  assert(selectsColumn(sel, "recurrence_group_id"));
});
