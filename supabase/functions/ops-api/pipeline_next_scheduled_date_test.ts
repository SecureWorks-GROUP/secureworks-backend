// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
// OpsDash date chip source (Captain rulings 2026-08-31): for Scheduled and
// In Progress cards the chip shows the next visit that has not happened yet,
// following reschedules; when nothing is ahead it falls back to the most
// recent PAST visit (option a). `next_scheduled_date` / `last_scheduled_date`
// are the additive pipeline fields carrying the pair;
// `first_scheduled_date` keeps its historical MIN() meaning.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _perthTodayYmd,
  _pipelineForTest,
  _pipelineVisitDateMaps,
} from "./index.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const TODAY = "2026-08-31";

Deno.test("next visit: a single-visit job ahead of today reports that visit and no past one", () => {
  const { next, last } = _pipelineVisitDateMaps(
    [{ job_id: JOB, scheduled_date: "2026-09-04" }],
    TODAY,
  );
  assertEquals(next[JOB], "2026-09-04");
  assertEquals(last[JOB], undefined);
});

Deno.test("no-upcoming fallback: a single-visit job whose visit already happened reports it as the last visit", () => {
  const { next, last } = _pipelineVisitDateMaps(
    [{ job_id: JOB, scheduled_date: "2026-08-05" }],
    TODAY,
  );
  assertEquals(next[JOB], undefined);
  assertEquals(last[JOB], "2026-08-05");
});

Deno.test("no-upcoming fallback: several past visits pick the MOST RECENT one, not the first", () => {
  // The SWB-26073 class: first visit months before the last crew attendance.
  const { next, last } = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-04-14" },
      { job_id: JOB, scheduled_date: "2026-05-27" },
      { job_id: JOB, scheduled_date: "2026-05-02" },
    ],
    TODAY,
  );
  assertEquals(next[JOB], undefined);
  assertEquals(last[JOB], "2026-05-27");
});

Deno.test("next visit: visits behind and ahead pick the earliest not-yet-happened one, today inclusive", () => {
  // Captain's worked example: 05/08 done, 31/08 and 11/09 ahead, today 31/08.
  const { next, last } = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-08-05" },
      { job_id: JOB, scheduled_date: "2026-09-11" },
      { job_id: JOB, scheduled_date: "2026-08-31" },
    ],
    TODAY,
  );
  assertEquals(next[JOB], "2026-08-31");
  assertEquals(last[JOB], "2026-08-05");
});

Deno.test("next visit: a reschedule moves the answer to the new date", () => {
  // Same example continued: 31/08 rescheduled to 04/09 -> chip follows.
  const before = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-08-05" },
      { job_id: JOB, scheduled_date: "2026-08-31" },
      { job_id: JOB, scheduled_date: "2026-09-11" },
    ],
    TODAY,
  );
  assertEquals(before.next[JOB], "2026-08-31");
  const after = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-08-05" },
      { job_id: JOB, scheduled_date: "2026-09-04" },
      { job_id: JOB, scheduled_date: "2026-09-11" },
    ],
    TODAY,
  );
  assertEquals(after.next[JOB], "2026-09-04");
});

Deno.test("ghost and observer rows never influence either value", () => {
  // A ghost watcher row keeps a stale-or-wrong date and must not win even when
  // it is the nearest upcoming date; same for role:'observer' rows — and the
  // same on the past side, where a ghost's stale date must not become the
  // fallback (SWF-26813's stuck 05/08 chip WAS a ghost row's date).
  const { next, last } = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-09-01", is_ghost: true },
      { job_id: JOB, scheduled_date: "2026-09-02", role: "observer" },
      { job_id: JOB, scheduled_date: "2026-08-30", is_ghost: true },
      { job_id: JOB, scheduled_date: "2026-08-29", role: "observer" },
      { job_id: JOB, scheduled_date: "2026-09-10" },
      { job_id: JOB, scheduled_date: "2026-08-06" },
    ],
    TODAY,
  );
  assertEquals(next[JOB], "2026-09-10");
  assertEquals(last[JOB], "2026-08-06");
  // Ghost-only rows leave the job with no visit dates at all.
  const ghostOnly = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-09-01", is_ghost: true },
      { job_id: JOB, scheduled_date: "2026-08-01", is_ghost: true },
    ],
    TODAY,
  );
  assertEquals(ghostOnly.next[JOB], undefined);
  assertEquals(ghostOnly.last[JOB], undefined);
});

Deno.test("a NULL-status visit is a real booking and still wins the next date", () => {
  // `job_assignments.status` is nullable, so a booked visit can arrive with no
  // status at all. Dropping it would put the chip back on the stale past date.
  const { next, last } = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-08-05", status: "completed" },
      { job_id: JOB, scheduled_date: "2026-09-04", status: null },
    ],
    TODAY,
  );
  assertEquals(next[JOB], "2026-09-04");
  assertEquals(last[JOB], "2026-08-05");
});

Deno.test("cancelled visits are excluded in code, not left to the read's filter", () => {
  const { next, last } = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: "2026-09-01", status: "cancelled" },
      { job_id: JOB, scheduled_date: "2026-08-20", status: "cancelled" },
      { job_id: JOB, scheduled_date: "2026-09-10", status: "scheduled" },
      { job_id: JOB, scheduled_date: "2026-08-06", status: "completed" },
    ],
    TODAY,
  );
  assertEquals(next[JOB], "2026-09-10");
  assertEquals(last[JOB], "2026-08-06");
});

Deno.test("undated visits produce no next or last date", () => {
  // Assignment rows exist but carry no scheduled_date — the job has visits on
  // the books with no day chosen, so there is nothing for the chip to show.
  const { next, last } = _pipelineVisitDateMaps(
    [
      { job_id: JOB, scheduled_date: null, status: "scheduled" },
      { job_id: JOB, status: "scheduled" },
      { job_id: JOB, scheduled_date: "", status: "scheduled" },
    ],
    TODAY,
  );
  assertEquals(next[JOB], undefined);
  assertEquals(last[JOB], undefined);
});

Deno.test("_perthTodayYmd formats a Perth calendar day", () => {
  // 2026-08-30T22:00Z is already 2026-08-31 in Perth (UTC+8): the chip must
  // not keep showing yesterday's visit until 8am Perth time.
  assertEquals(_perthTodayYmd(new Date("2026-08-30T22:00:00Z")), "2026-08-31");
  assertEquals(_perthTodayYmd(new Date("2026-08-30T15:00:00Z")), "2026-08-30");
});

// ── Pipeline wiring: the fields ride every card and leave the old ones alone ─

// The fixture client reproduces PostgREST/SQL three-valued logic, because that
// is exactly what this regression turns on: `.neq(col, v)` drops a row whose
// `col` is NULL, while an explicit `col.is.null` term keeps it.
const isNullish = (value: unknown) => value === null || value === undefined;

function matchesOrTerm(row: any, term: string): boolean {
  const [column, ...rest] = term.split(".");
  const op = rest.join(".");
  const value = row[column];
  if (op === "is.null") return isNullish(value);
  if (op === "not.is.null") return !isNullish(value);
  if (op.startsWith("neq.")) {
    return !isNullish(value) && String(value) !== op.slice(4);
  }
  if (op.startsWith("eq.")) {
    return !isNullish(value) && String(value) === op.slice(3);
  }
  throw new Error(`fixture client: unsupported or() term ${term}`);
}

function makeClient(tables: Record<string, any[]>) {
  function from(table: string) {
    let selectSpec = "";
    const eqFilters: Array<[string, unknown]> = [];
    const neqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    const orFilters: string[] = [];
    let rowLimit: number | null = null;

    const apply = () => {
      if (table === "jobs" && selectSpec === "id, pricing_json") return [];
      let rows = [...(tables[table] || [])];
      for (const [column, value] of eqFilters) {
        rows = rows.filter((row) => row[column] === value);
      }
      for (const [column, value] of neqFilters) {
        rows = rows.filter((row) =>
          !isNullish(row[column]) && row[column] !== value
        );
      }
      for (const spec of orFilters) {
        const terms = spec.split(",");
        rows = rows.filter((row) =>
          terms.some((term) => matchesOrTerm(row, term))
        );
      }
      for (const [column, values] of inFilters) {
        rows = rows.filter((row) => values.includes(row[column]));
      }
      return rowLimit == null ? rows : rows.slice(0, rowLimit);
    };

    const builder: any = {
      select: (columns: string) => {
        selectSpec = columns;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        eqFilters.push([column, value]);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        neqFilters.push([column, value]);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        inFilters.push([column, values]);
        return builder;
      },
      not: () => builder,
      or: (spec: string) => {
        orFilters.push(spec);
        return builder;
      },
      is: () => builder,
      order: () => builder,
      limit: (value: number) => {
        rowLimit = value;
        return builder;
      },
      range: async (fromIdx: number, to: number) => ({
        data: apply().slice(fromIdx, to + 1),
        error: null,
      }),
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
    };
    return builder;
  }
  return { from };
}

Deno.test("pipeline: next/last_scheduled_date ride the card while first_scheduled_date and assignment_count keep their meaning", async () => {
  // Far past/future dates keep the assertion independent of the wall clock.
  const client = makeClient({
    jobs: [{
      id: JOB,
      org_id: "00000000-0000-0000-0000-000000000001",
      type: "fencing",
      status: "in_progress",
      client_name: "Corrine Example",
      job_number: "SWF-2001",
      updated_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
    }],
    job_assignments: [
      // Real past visits — the earliest stays first_scheduled_date, the most
      // recent becomes last_scheduled_date.
      {
        id: "a1",
        job_id: JOB,
        scheduled_date: "2020-01-05",
        status: "completed",
      },
      {
        id: "a7",
        job_id: JOB,
        scheduled_date: "2021-02-03",
        status: "completed",
      },
      // Ghost + observer rows carry nearer future dates and must not win the
      // next date, while still counting in assignment_count as they always have.
      {
        id: "a2",
        job_id: JOB,
        scheduled_date: "2098-01-01",
        is_ghost: true,
        role: "observer",
        status: "scheduled",
      },
      {
        id: "a3",
        job_id: JOB,
        scheduled_date: "2098-06-01",
        role: "observer",
        status: "scheduled",
      },
      // The crew's genuine return visits.
      {
        id: "a4",
        job_id: JOB,
        scheduled_date: "2099-03-01",
        status: "scheduled",
      },
      {
        id: "a5",
        job_id: JOB,
        scheduled_date: "2099-09-01",
        status: "scheduled",
      },
      // Cancelled rows stay excluded from everything, as before.
      {
        id: "a6",
        job_id: JOB,
        scheduled_date: "2099-01-01",
        status: "cancelled",
      },
    ],
  });

  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );

  assertEquals(result.total, 1);
  const card = result.columns.in_progress[0];
  assert(card, "job must land in the in_progress column");
  assertEquals(card.first_scheduled_date, "2020-01-05");
  assertEquals(card.next_scheduled_date, "2099-03-01");
  assertEquals(card.last_scheduled_date, "2021-02-03");
  assertEquals(card.assignment_count, 6);
});

Deno.test("pipeline: an all-past job carries the most recent past visit and no next date", async () => {
  const client = makeClient({
    jobs: [{
      id: JOB,
      org_id: "00000000-0000-0000-0000-000000000001",
      type: "patio",
      status: "in_progress",
      client_name: "Awaiting Closeout",
      job_number: "SWB-2003",
      updated_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
    }],
    job_assignments: [
      {
        id: "b1",
        job_id: JOB,
        scheduled_date: "2020-04-14",
        status: "completed",
      },
      {
        id: "b2",
        job_id: JOB,
        scheduled_date: "2020-05-27",
        status: "completed",
      },
    ],
  });

  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=patio"),
  );

  const card = result.columns.in_progress[0];
  assert(card, "job must land in the in_progress column");
  assertEquals(card.first_scheduled_date, "2020-04-14");
  assertEquals(card.next_scheduled_date, null);
  assertEquals(card.last_scheduled_date, "2020-05-27");
});

Deno.test("pipeline: a NULL-status upcoming visit reaches next_scheduled_date while the frozen fields keep the old exclusion", async () => {
  const client = makeClient({
    jobs: [{
      id: JOB,
      org_id: "00000000-0000-0000-0000-000000000001",
      type: "fencing",
      status: "in_progress",
      client_name: "Null Status Booking",
      job_number: "SWF-2004",
      updated_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
    }],
    job_assignments: [
      {
        id: "c1",
        job_id: JOB,
        scheduled_date: "2020-08-05",
        status: "completed",
      },
      // The booked return visit, stored with no status at all. A `.neq` read
      // drops it (SQL three-valued logic) and the chip goes stale on 2020-08-05.
      { id: "c2", job_id: JOB, scheduled_date: "2099-09-04", status: null },
    ],
  });

  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );

  const card = result.columns.in_progress[0];
  assert(card, "job must land in the in_progress column");
  assertEquals(card.next_scheduled_date, "2099-09-04");
  assertEquals(card.last_scheduled_date, "2020-08-05");
  // Frozen: the two older fields see exactly the rows the old read returned,
  // so the NULL-status row is still invisible to them.
  assertEquals(card.assignment_count, 1);
  assertEquals(card.first_scheduled_date, "2020-08-05");
});

Deno.test("pipeline: undated visits count as assignments but leave all three dates null", async () => {
  const client = makeClient({
    jobs: [{
      id: JOB,
      org_id: "00000000-0000-0000-0000-000000000001",
      type: "fencing",
      status: "scheduled",
      client_name: "Crew Booked, Day Unset",
      job_number: "SWF-2005",
      updated_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
    }],
    job_assignments: [
      { id: "d1", job_id: JOB, scheduled_date: null, status: "scheduled" },
      { id: "d2", job_id: JOB, scheduled_date: null, status: "scheduled" },
    ],
  });

  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );

  const card = result.columns.scheduled[0];
  assert(card, "job must land in the scheduled column");
  assertEquals(card.assignment_count, 2);
  assertEquals(card.first_scheduled_date, null);
  assertEquals(card.next_scheduled_date, null);
  assertEquals(card.last_scheduled_date, null);
});

Deno.test("pipeline: a job with no dated visits carries null in all three fields", async () => {
  const client = makeClient({
    jobs: [{
      id: JOB,
      org_id: "00000000-0000-0000-0000-000000000001",
      type: "fencing",
      status: "scheduled",
      client_name: "No Visits Yet",
      job_number: "SWF-2002",
      updated_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
    }],
    job_assignments: [],
  });

  const result = await _pipelineForTest(
    client,
    new URLSearchParams("type=fencing"),
  );

  const card = result.columns.scheduled[0];
  assert(card, "job must land in the scheduled column");
  assertEquals(card.first_scheduled_date, null);
  assertEquals(card.next_scheduled_date, null);
  assertEquals(card.last_scheduled_date, null);
});
