import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _managerBoardVerticals,
  _resolveManagerVisibility,
  _resolveTradeJobFeedLens,
  myJobs,
  searchAllJobs,
  type TradeAuthContext,
  tradeCalendarEvents,
} from "./index.ts";

// ── Captain's ruling, 2026-07-31: "when they go to all, all needs to mean all" ─
//
// The scout diagnosis (jan-trade-visibility-scout-v1) found the trade app's
// WIDEST lens was also one of its narrowest: a dispatcher's Everyone feed was
// floored at 30 days while a vertical manager's ran full-range, so the company
// owner saw 58 fencing jobs where the fencing lead saw 102. On top of that the
// open pools stopped at an arbitrary `limit(80)` newest rows, and the All tab's
// empty-query browse returned only the viewer's own assignments.
//
// These tests pin the three visibility seams the report named:
//   * _resolveManagerVisibility / _managerBoardVerticals — role → lens
//   * the myJobs showAll branch — full range, paged, uncapped pools
//   * dispatcher ⊇ vertical-manager parity — the inversion must not come back
// plus the All-tab job feed (searchAllJobs), which is the only trade surface
// that can show a job that was NEVER allocated to crew.

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";

type Job = {
  id: string;
  org_id?: string;
  type: string;
  status: string;
  job_number?: string;
  client_name?: string;
  site_suburb?: string;
  created_at?: string;
};
type Assignment = {
  id: string;
  user_id: string;
  user_name?: string;
  status: string;
  scheduled_date: string | null;
  job_id: string;
};
type Detail = { job_id: string; substatus?: string; last_reattend_at?: string; external_ref?: string };
type Fixtures = {
  assignments: Assignment[];
  jobs: Job[];
  details?: Detail[];
  calendar?: CalendarEvent[];
};

type CalendarEvent = {
  assignment_id: string;
  job_id: string;
  user_id: string;
  job_type: string;
  job_number?: string;
  scheduled_date: string;
  scheduled_end?: string | null;
  assignment_status?: string;
  org_id?: string;
};

type RecordedQuery = {
  table: string;
  select: string;
  head: boolean;
  eq: Record<string, unknown>;
  neq: Record<string, unknown>;
  gte: Record<string, string>;
  lte: Record<string, string>;
  lt: Record<string, string>;
  notIn: string | null;
  inCol: string | null;
  inVals: unknown[] | null;
  or: { str: string; referencedTable: string | null } | null;
  ors: { str: string; referencedTable: string | null }[];
  range: [number, number] | null;
  limit: number | null;
};

function jobOrg(job: Job): string {
  return job.org_id || TENANT_A;
}

// A comma-separated PostgREST or() string: `col.op.val`, OR-combined.
function matchOr(row: Record<string, unknown>, orStr: string): boolean {
  return orStr.split(",").some((cond) => {
    const [col, op, ...rest] = cond.split(".");
    const val = rest.join(".");
    const cell = String((row ?? {})[col] ?? "");
    if (op === "eq") return cell === val;
    if (op === "ilike") {
      const pat = val.replace(/^%/, "").replace(/%$/, "").toLowerCase();
      return val.startsWith("%")
        ? cell.toLowerCase().includes(pat)
        : cell.toLowerCase().startsWith(pat);
    }
    return false;
  });
}

function parseNotInSet(filterStr: string): Set<string> {
  const out = new Set<string>();
  for (const m of filterStr.matchAll(/"([^"]+)"/g)) out.add(m[1]);
  return out;
}

function page<T>(rows: T[], st: RecordedQuery): T[] {
  if (st.range) return rows.slice(st.range[0], st.range[1] + 1);
  if (st.limit != null) return rows.slice(0, st.limit);
  return rows.slice(0, 1000);
}

function resolve(fx: Fixtures, st: RecordedQuery): { data: unknown[] | null; error: null; count?: number } {
  if (st.table === "job_assignments") {
    let rows = fx.assignments.slice();
    if (st.eq.user_id != null) rows = rows.filter((a) => a.user_id === st.eq.user_id);
    if (st.neq.status != null) rows = rows.filter((a) => a.status !== st.neq.status);
    if (st.notIn) {
      const closed = parseNotInSet(st.notIn);
      rows = rows.filter((a) => !closed.has(a.status));
    }
    if (st.gte.scheduled_date != null) {
      rows = rows.filter((a) => a.scheduled_date != null && a.scheduled_date >= st.gte.scheduled_date);
    }
    if (st.lt.scheduled_date != null) {
      rows = rows.filter((a) => a.scheduled_date != null && a.scheduled_date < st.lt.scheduled_date);
    }
    // Inner join on jobs; a referenced-table or() constrains the parent rows.
    let joined = rows
      .map((a) => ({ a, job: fx.jobs.find((j) => j.id === a.job_id) }))
      .filter((x) => x.job) as { a: Assignment; job: Job }[];
    if (st.eq["jobs.org_id"] != null) {
      joined = joined.filter((x) => jobOrg(x.job) === st.eq["jobs.org_id"]);
    }
    if (st.or && st.or.referencedTable === "jobs") {
      joined = joined.filter((x) => matchOr(x.job as unknown as Record<string, unknown>, st.or!.str));
    }
    if (st.inCol === "job_id" && st.inVals) {
      // The occupancy probe: returns the occupying assignment for those ids.
      return {
        data: page(
          joined
            .filter((x) => st.inVals!.includes(x.a.job_id))
            .map(({ a }) => ({
              id: a.id,
              job_id: a.job_id,
              scheduled_date: a.scheduled_date,
              status: a.status,
              role: "lead",
              assignment_type: "install",
              user: { id: a.user_id, name: a.user_name ?? a.user_id },
            })),
          st,
        ),
        error: null,
      };
    }
    // The assigned-browse seed selects an embedded jobs row, not a flat row.
    if (st.select.startsWith("jobs:job_id(")) {
      return { data: page(joined.map(({ job }) => ({ jobs: { ...job } })), st), error: null };
    }
    const isAdminSelect = st.select.includes("user:user_id");
    return {
      data: page(
        joined.map(({ a, job }) => ({
          id: a.id,
          scheduled_date: a.scheduled_date,
          status: a.status,
          role: "lead",
          assignment_type: "install",
          jobs: { ...job },
          ...(isAdminSelect ? { user: { id: a.user_id, name: a.user_name ?? a.user_id } } : {}),
        })),
        st,
      ),
      error: null,
    };
  }
  if (st.table === "jobs") {
    let rows = fx.jobs.slice();
    if (st.eq.org_id != null) rows = rows.filter((j) => jobOrg(j) === st.eq.org_id);
    if (st.eq.type != null) rows = rows.filter((j) => j.type === st.eq.type);
    if (st.eq.status != null) rows = rows.filter((j) => j.status === st.eq.status);
    if (st.inCol === "id" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.id));
    if (st.inCol === "status" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.status));
    if (st.or && st.or.referencedTable == null) {
      rows = rows.filter((j) => matchOr(j as unknown as Record<string, unknown>, st.or!.str));
    }
    if (st.notIn) {
      const excluded = parseNotInSet(st.notIn);
      rows = rows.filter((j) => !excluded.has(j.status));
    }
    rows = rows.slice().sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || "")) ||
      String(a.id).localeCompare(String(b.id))
    );
    if (st.head) return { data: null, error: null, count: rows.length };
    return { data: page(rows.map((j) => ({ ...j })), st), error: null };
  }
  if (st.table === "makesafe_job_details") {
    let rows = (fx.details || []).slice();
    if (st.inCol === "job_id" && st.inVals) rows = rows.filter((d) => st.inVals!.includes(d.job_id));
    return { data: page(rows.map((d) => ({ ...d })), st), error: null };
  }
  if (st.table === "calendar_events") {
    let rows = (fx.calendar || []).slice();
    if (st.eq.org_id != null) rows = rows.filter((e) => (e.org_id || TENANT_A) === st.eq.org_id);
    if (st.eq.user_id != null) rows = rows.filter((e) => e.user_id === st.eq.user_id);
    if (st.neq.assignment_status != null) {
      rows = rows.filter((e) => (e.assignment_status || "scheduled") !== st.neq.assignment_status);
    }
    if (st.lte.scheduled_date != null) rows = rows.filter((e) => e.scheduled_date <= st.lte.scheduled_date);
    // Two or() calls can land on this query: the scheduled_end overlap window
    // (which this mock does not model — it contains an and() group) and the
    // vertical filter. Apply only the latter; the tests assert the former by
    // inspecting the recorded filters.
    for (const orFilter of st.ors) {
      if (!/job_type|job_number/.test(orFilter.str)) continue;
      rows = rows.filter((e) => matchOr(e as unknown as Record<string, unknown>, orFilter.str));
    }
    rows = rows.slice().sort((a, b) =>
      a.scheduled_date.localeCompare(b.scheduled_date) ||
      a.assignment_id.localeCompare(b.assignment_id)
    );
    return { data: page(rows.map((e) => ({ ...e })), st), error: null };
  }
  return { data: [], error: null };
}

function makeClient(fx: Fixtures, recorded: RecordedQuery[] = []) {
  function from(table: string) {
    const st: RecordedQuery = {
      table, select: "", head: false, eq: {}, neq: {}, gte: {}, lte: {}, lt: {},
      notIn: null, inCol: null, inVals: null, or: null, ors: [], range: null, limit: null,
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: (s: string, opts?: { count?: string; head?: boolean }) => {
        st.select = s;
        if (opts?.head) st.head = true;
        return b;
      },
      eq: (k: string, v: unknown) => { st.eq[k] = v; return b; },
      neq: (k: string, v: unknown) => { st.neq[k] = v; return b; },
      gte: (k: string, v: string) => { st.gte[k] = v; return b; },
      lte: (k: string, v: string) => { st.lte[k] = v; return b; },
      lt: (k: string, v: string) => { st.lt[k] = v; return b; },
      in: (k: string, arr: unknown[]) => { st.inCol = k; st.inVals = arr; return b; },
      not: (k: string, op: string, v: string) => {
        if (k === "status" && op === "in") st.notIn = v;
        return b;
      },
      or: (s: string, opts?: { referencedTable?: string }) => {
        st.or = { str: s, referencedTable: opts?.referencedTable ?? null };
        st.ors.push(st.or);
        return b;
      },
      ilike: () => b,
      order: () => b,
      limit: (n: number) => { st.limit = n; return b; },
      range: (lo: number, hi: number) => { st.range = [lo, hi]; return b; },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (done: any) => { recorded.push(st); done(resolve(fx, st)); },
    };
    return b;
  }
  return { from };
}

// deno-lint-ignore no-explicit-any
function nonPool(g: any): any[] {
  return [...g.today, ...g.thisWeek, ...g.upcoming, ...g.recent, ...(g.unscheduled || [])];
}
// deno-lint-ignore no-explicit-any
function assignedJobIds(g: any): string[] { return nonPool(g).map((a) => a.jobs?.id); }
// deno-lint-ignore no-explicit-any
function poolJobIds(g: any): string[] { return (g.makesafePool as any[]).map((a) => a.jobs?.id); }

const MARNIN = _resolveManagerVisibility({ role: "admin", managedVerticals: ["makesafe", "fencing", "patio", "decking"] });
const HENRY = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["fencing"] });
const ALYX = _resolveManagerVisibility({ role: "installer", managedVerticals: [] });

// deno-lint-ignore no-explicit-any
function dispatcherJobs(client: any) {
  // mode:'all' for a dispatcher → showAll=true, managerScope=[] (they never use
  // the vertical widening), which is exactly what the route computes.
  return myJobs(client, "u-marnin", true, MARNIN.isDispatcher, MARNIN.isMakesafeManager, MARNIN.poolVerticals, [], TENANT_A);
}

// A history spanning years, verticals, crews and tenants. Everything dated
// before ~30 days ago was invisible to a dispatcher before this change.
function historyFixtures(): Fixtures {
  return {
    assignments: [
      { id: "a-2024", user_id: "u-crew1", status: "complete", scheduled_date: "2024-03-11", job_id: "job-old-fencing" },
      { id: "a-2025", user_id: "u-crew2", status: "complete", scheduled_date: "2025-11-04", job_id: "job-old-makesafe" },
      { id: "a-future", user_id: "u-crew3", status: "scheduled", scheduled_date: "2032-02-09", job_id: "job-future-patio" },
      { id: "a-null", user_id: "u-crew4", status: "scheduled", scheduled_date: null, job_id: "job-unscheduled-decking" },
      { id: "a-tenant-b", user_id: "u-crew-b", status: "scheduled", scheduled_date: "2032-02-09", job_id: "job-tenant-b" },
    ],
    jobs: [
      { id: "job-old-fencing", type: "fencing", status: "invoiced", job_number: "SWF-26489" },
      { id: "job-old-makesafe", type: "makesafe", status: "archived", job_number: "SWMS-2200" },
      { id: "job-future-patio", type: "patio", status: "scheduled", job_number: "SWP-9001" },
      { id: "job-unscheduled-decking", type: "decking", status: "in_progress", job_number: "SWD-4100" },
      { id: "job-tenant-b", org_id: TENANT_B, type: "fencing", status: "in_progress", job_number: "SWF-B" },
    ],
  };
}

Deno.test("dispatcher Everyone carries the full range — years-old, future and unscheduled work all show", async () => {
  const recorded: RecordedQuery[] = [];
  const grouped = await dispatcherJobs(makeClient(historyFixtures(), recorded));

  assertEquals(assignedJobIds(grouped).sort(), [
    "job-future-patio",
    "job-old-fencing",
    "job-old-makesafe",
    "job-unscheduled-decking",
  ]);
  assertEquals(
    grouped.unscheduled.map((a: { jobs?: { id?: string } }) => a.jobs?.id),
    ["job-unscheduled-decking"],
    "a null-dated allocation is carried, not dropped by a date filter",
  );
  assertEquals(
    assignedJobIds(grouped).includes("job-tenant-b"),
    false,
    "see-all still stops at the viewer's tenant",
  );

  // The seam itself: the see-all assignment query no longer carries a date floor.
  const primary = recorded.find((q) =>
    q.table === "job_assignments" && q.inCol == null && q.eq.user_id == null && q.or == null
  );
  assertEquals(primary?.gte.scheduled_date, undefined, "no 30-day floor on the see-all feed");
  assertEquals(primary?.eq["jobs.org_id"], TENANT_A, "still tenant-scoped");
  assertEquals(String(primary?.select || "").includes("jobs:job_id!inner"), true, "via an inner join");
});

// The exact inversion the scout found: Henry (fencing lead) saw 102 fencing jobs
// where Jan and Marnin (owners) saw 58. Whatever a vertical manager can see of
// their vertical, a dispatcher must see too.
Deno.test("parity: a dispatcher's Everyone set contains the fencing manager's Everyone set", async () => {
  const fx = (): Fixtures => ({
    assignments: [
      { id: "a-old-1", user_id: "u-crew1", status: "complete", scheduled_date: "2024-05-02", job_id: "job-f-old-1" },
      { id: "a-old-2", user_id: "u-crew2", status: "complete", scheduled_date: "2025-01-19", job_id: "job-f-old-2" },
      { id: "a-null", user_id: "u-crew3", status: "scheduled", scheduled_date: null, job_id: "job-f-null" },
      { id: "a-future", user_id: "u-crew4", status: "scheduled", scheduled_date: "2032-02-09", job_id: "job-f-future" },
    ],
    jobs: [
      { id: "job-f-old-1", type: "fencing", status: "invoiced", job_number: "SWF-26551" },
      { id: "job-f-old-2", type: "fencing", status: "archived", job_number: "SWF-26489" },
      { id: "job-f-null", type: "fencing", status: "awaiting_supplier", job_number: "SWF-26378" },
      { id: "job-f-future", type: "fencing", status: "in_progress", job_number: "SWF-26850" },
    ],
  });

  const managerScope = _managerBoardVerticals({ isDispatcher: HENRY.isDispatcher, mode: "all", managedVerticals: ["fencing"] });
  const henry = await myJobs(
    makeClient(fx()), "u-henry", false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, managerScope, TENANT_A,
  );
  const marnin = await dispatcherJobs(makeClient(fx()));

  const henrySees = new Set(assignedJobIds(henry));
  const marninSees = new Set(assignedJobIds(marnin));
  assertEquals(henrySees.size, 4, "the fencing lead sees the whole fencing history");
  for (const jobId of henrySees) {
    assertEquals(marninSees.has(jobId), true, `the owner must also see ${jobId}`);
  }
});

Deno.test("dispatcher Everyone pages the complete range without duplicates", async () => {
  const count = 1005;
  const fixtures: Fixtures = {
    assignments: Array.from({ length: count }, (_, i) => ({
      id: `a-${String(i).padStart(4, "0")}`,
      user_id: `crew-${i}`,
      status: "scheduled",
      scheduled_date: "2032-02-09",
      job_id: `job-${String(i).padStart(4, "0")}`,
    })),
    jobs: Array.from({ length: count }, (_, i) => ({
      id: `job-${String(i).padStart(4, "0")}`,
      type: "fencing",
      status: "in_progress",
      job_number: `SWF-${String(i).padStart(4, "0")}`,
    })),
  };
  const recorded: RecordedQuery[] = [];
  const grouped = await dispatcherJobs(makeClient(fixtures, recorded));
  const ids = assignedJobIds(grouped);

  assertEquals(ids.length, count, "every assignment past the 1000-row cap is present");
  assertEquals(new Set(ids).size, count, "and none arrives twice across the page boundary");
  const pages = recorded
    .filter((q) => q.table === "job_assignments" && q.inCol == null && q.eq.user_id == null)
    .map((q) => q.range);
  assertEquals(pages, [[0, 999], [1000, 1999]]);
});

// Scope item 3: the ruling widens the Everyone lens only. An installer's feed —
// the one on the most phones — must be byte-identical to before.
Deno.test("regression: an ordinary installer is untouched — own-only, still windowed", async () => {
  const fx = (): Fixtures => ({
    assignments: [
      { id: "a-mine", user_id: "u-alyx", status: "scheduled", scheduled_date: "2032-02-09", job_id: "job-mine" },
      { id: "a-theirs", user_id: "u-other", status: "scheduled", scheduled_date: "2032-02-09", job_id: "job-theirs" },
    ],
    jobs: [
      { id: "job-mine", type: "fencing", status: "in_progress" },
      { id: "job-theirs", type: "fencing", status: "in_progress" },
    ],
  });
  // The route computes showAll=false and managerScope=[] for an installer on
  // EITHER mode, so both lenses run the same call.
  assertEquals(_managerBoardVerticals({ isDispatcher: ALYX.isDispatcher, mode: "all", managedVerticals: [] }), []);
  const recorded: RecordedQuery[] = [];
  const all = await myJobs(makeClient(fx(), recorded), "u-alyx", false, ALYX.isDispatcher, ALYX.isMakesafeManager, ALYX.poolVerticals, []);
  const mine = await myJobs(makeClient(fx()), "u-alyx", false, ALYX.isDispatcher, ALYX.isMakesafeManager, ALYX.poolVerticals, []);

  assertEquals(all, mine);
  assertEquals(assignedJobIds(all), ["job-mine"]);
  assertEquals(poolJobIds(all), [], "no pool is opened for a crew member");
  const primary = recorded.find((q) => q.table === "job_assignments");
  assertEquals(primary?.eq.user_id, "u-alyx");
  assertEquals(typeof primary?.gte.scheduled_date, "string", "the personal feed keeps its 30-day window");
  assertEquals(primary?.range, null, "and stays a single unpaged read");
});

// The manager branch's non-fencing lanes were deliberately left rolling by U2b.
// Widening showAll must not have leaked into them.
Deno.test("regression: a vertical manager's non-fencing lane keeps its rolling window", async () => {
  const nithin = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["patio"] });
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({ isDispatcher: nithin.isDispatcher, mode: "all", managedVerticals: ["patio"] });
  await myJobs(
    makeClient({ assignments: [], jobs: [] }, recorded), "u-nithin",
    false, nithin.isDispatcher, nithin.isMakesafeManager, nithin.poolVerticals, managerScope, TENANT_A,
  );
  const rolling = recorded.find((q) => q.table === "job_assignments" && q.or?.str === "type.eq.patio");
  assertEquals(typeof rolling?.gte.scheduled_date, "string", "patio manager lane is still 30-day windowed");
});

// ~169 active make-safes were on the Board but not in the Jobs list, because the
// pool stopped at the 80 newest rows and then sliced to 80 again.
Deno.test("the open make-safe pool is complete, not the newest 80", async () => {
  const total = 130;
  const fixtures: Fixtures = {
    assignments: [],
    jobs: Array.from({ length: total }, (_, i) => ({
      id: `job-ms-${String(i).padStart(3, "0")}`,
      type: "makesafe",
      status: "accepted",
      job_number: `SWMS-${String(i).padStart(3, "0")}`,
      created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    })),
  };
  const recorded: RecordedQuery[] = [];
  const grouped = await dispatcherJobs(makeClient(fixtures, recorded));

  assertEquals(poolJobIds(grouped).length, total, "every allocatable make-safe is offered, not 80 of them");
  assertEquals(new Set(poolJobIds(grouped)).size, total, "one job = one pool card");
  const poolRead = recorded.find((q) => q.table === "jobs" && q.or?.str.includes("type.eq.makesafe"));
  assertEquals(poolRead?.limit, null, "the arbitrary limit(80) is gone");
  assertEquals(poolRead?.range?.[0], 0, "replaced by a paged read");
});

// Uncapping the pool uncapped its enrichment too. The whole-table scan that
// finds legacy imports must stay SLIM (four predicate columns); the `select('*')`
// rows — one per make-safe job ever created, plus a company join — must be
// fetched only for the ids that actually reached the pool.
Deno.test("make-safe detail reads: slim table scan, bounded full-row enrichment", async () => {
  const fixtures: Fixtures = {
    assignments: [],
    jobs: [
      { id: "job-ms-open", type: "makesafe", status: "accepted", job_number: "SWMS-500" },
      { id: "job-ms-admin", type: "makesafe", status: "accepted", job_number: "SWMS-501" },
      // A legacy import: neither the type nor the number identifies it as a
      // make-safe, so only its detail row can surface it.
      { id: "job-ms-legacy", type: "general", status: "accepted", job_number: "LEG-9" },
    ],
    details: [
      { job_id: "job-ms-open", substatus: "allocated" },
      { job_id: "job-ms-admin", substatus: "company_contact_required" },
      { job_id: "job-ms-legacy", substatus: "allocated" },
    ],
  };
  const recorded: RecordedQuery[] = [];
  const grouped = await dispatcherJobs(makeClient(fixtures, recorded));

  assertEquals(poolJobIds(grouped).sort(), ["job-ms-legacy", "job-ms-open"]);
  assertEquals(
    poolJobIds(grouped).includes("job-ms-admin"),
    false,
    "company_contact_required is ops's admin queue, still not allocatable",
  );

  const detailReads = recorded.filter((q) => q.table === "makesafe_job_details");
  const tableScan = detailReads.find((q) => q.inCol == null);
  assertEquals(tableScan?.select.includes("*"), false, "the whole-table scan selects no blob columns");
  assertEquals(tableScan?.select.includes("substatus"), true, "just what the predicate reads");

  const fullRows = detailReads.filter((q) => q.select.includes("*"));
  assertEquals(fullRows.length > 0, true, "pool cards still get their full detail row");
  for (const read of fullRows) {
    assertEquals(read.inCol, "job_id", "scoped to specific pool ids…");
    assertEquals((read.inVals || []).length <= 25, true, "…and chunked for URL length");
  }
  const contactReads = recorded.filter((q) => q.table === "job_contacts");
  assertEquals(contactReads.every((q) => (q.inVals || []).length <= 25), true, "contact backfill ids are chunked too");
  const enrichedIds = fullRows.flatMap((r) => (r.inVals || []) as string[]);
  assertEquals(
    enrichedIds.includes("job-ms-admin"),
    false,
    "a job filtered out of the pool is never enriched",
  );
});

Deno.test("the generic vertical pool is complete, not the newest 80", async () => {
  const total = 95;
  const fixtures: Fixtures = {
    assignments: [],
    jobs: Array.from({ length: total }, (_, i) => ({
      id: `job-f-${String(i).padStart(3, "0")}`,
      type: "fencing",
      status: "schedule_install",
      job_number: `SWF-${String(i).padStart(3, "0")}`,
    })),
  };
  const recorded: RecordedQuery[] = [];
  const grouped = await dispatcherJobs(makeClient(fixtures, recorded));

  assertEquals(poolJobIds(grouped).length, total);
  const poolRead = recorded.find((q) => q.table === "jobs" && q.eq.type === "fencing");
  assertEquals(poolRead?.limit, null, "the arbitrary limit(80) is gone");
});

// A job with several visits must still render one card per job on the board's
// pool lane and never a duplicate synthetic "available" card.
Deno.test("one job = one card no matter how many assignments it carries", async () => {
  const fixtures: Fixtures = {
    assignments: Array.from({ length: 6 }, (_, i) => ({
      id: `a-visit-${i}`,
      user_id: "u-crew1",
      status: "complete",
      scheduled_date: `2026-0${i + 1}-05`,
      job_id: "job-rectification",
    })),
    jobs: [{ id: "job-rectification", type: "fencing", status: "schedule_install", job_number: "SWF-26624" }],
  };
  const grouped = await dispatcherJobs(makeClient(fixtures));

  assertEquals(poolJobIds(grouped), [], "a job held by a live allocation is never offered as available");
  const cards = nonPool(grouped).filter((a) => a.jobs?.id === "job-rectification");
  assertEquals(cards.length, 6, "each real visit is still carried (the board needs per-week rows)");
  assertEquals(new Set(cards.map((a) => a.id)).size, 6, "and no visit is duplicated");
});

// ── All tab: the only trade surface that reads the JOB table ─────────────────

Deno.test("_resolveTradeJobFeedLens: who gets the whole company on an empty query", () => {
  assertEquals(
    _resolveTradeJobFeedLens({ isDispatcher: true, managedVerticals: [], q: "" }).lens,
    "company",
    "a dispatcher browses the whole tenant",
  );
  assertEquals(
    _resolveTradeJobFeedLens({ isDispatcher: false, managedVerticals: ["fencing"], q: "" }).lens,
    "company",
    "a vertical manager has the Everyone lens too",
  );
  assertEquals(
    _resolveTradeJobFeedLens({ isDispatcher: false, managedVerticals: [], q: "" }).lens,
    "assigned",
    "ordinary crew keep the own-assignments browse",
  );
  assertEquals(
    _resolveTradeJobFeedLens({ isDispatcher: false, managedVerticals: [], q: "kalamunda" }).lens,
    "search",
    "a typed query is a global search for everyone (unchanged)",
  );
  assertEquals(
    _resolveTradeJobFeedLens({ isDispatcher: true, managedVerticals: [], q: "   " }).lens,
    "company",
    "whitespace is not a query",
  );
});

function viewer(overrides: Partial<TradeAuthContext> = {}): TradeAuthContext {
  return {
    id: "u-marnin",
    email: "marnin@example.com",
    orgId: TENANT_A,
    role: "admin",
    managedVerticals: ["makesafe", "fencing", "patio", "decking"],
    ...overrides,
  };
}

// The heart of the ruling: 2,369 company jobs exist but only ~365 have any
// assignment, so a never-allocated job appeared in NO trade view at all.
function catalogFixtures(): Fixtures {
  return {
    assignments: [
      { id: "a-1", user_id: "u-alyx", status: "scheduled", scheduled_date: "2032-02-09", job_id: "job-assigned" },
    ],
    jobs: [
      { id: "job-assigned", type: "fencing", status: "in_progress", job_number: "SWF-26850", created_at: "2026-07-01T00:00:00Z" },
      { id: "job-never-assigned", type: "fencing", status: "awaiting_supplier", job_number: "SWF-261099", created_at: "2026-06-01T00:00:00Z" },
      { id: "job-quoted", type: "patio", status: "quoted", job_number: "SWP-1234", created_at: "2026-05-01T00:00:00Z" },
      { id: "job-archived", type: "makesafe", status: "archived", job_number: "SWMS-900", created_at: "2026-04-01T00:00:00Z" },
      { id: "job-cancelled", type: "decking", status: "cancelled", job_number: "SWD-77", created_at: "2026-03-01T00:00:00Z" },
      { id: "job-dupe", type: "fencing", status: "duplicate", job_number: "SWF-DUPE", created_at: "2026-02-01T00:00:00Z" },
      { id: "job-tenant-b", org_id: TENANT_B, type: "fencing", status: "in_progress", job_number: "SWF-B", created_at: "2026-07-02T00:00:00Z" },
    ],
  };
}

Deno.test("All tab: a dispatcher's empty query returns every company job, including never-assigned pipeline work", async () => {
  const res = await searchAllJobs(makeClient(catalogFixtures()), new URLSearchParams(), viewer(), true);

  const ids = res.jobs.map((j: { id: string }) => j.id).sort();
  assertEquals(ids, [
    "job-archived",
    "job-assigned",
    "job-cancelled",
    "job-never-assigned",
    "job-quoted",
  ]);
  assertEquals(res.lens, "company");
  assertEquals(res.total, 5, "the count the client shows is the real one");
  assertEquals(res.truncated, false);
  assertEquals(res.next_offset, null);
});

Deno.test("All tab: the company feed stops at the tenant and drops void/duplicate records", async () => {
  const res = await searchAllJobs(makeClient(catalogFixtures()), new URLSearchParams(), viewer(), true);
  const ids = res.jobs.map((j: { id: string }) => j.id);

  assertEquals(ids.includes("job-tenant-b"), false, "another tenant's jobs never appear");
  assertEquals(ids.includes("job-dupe"), false, "a known duplicate record stays out — one job, one card");
  assertEquals(ids.includes("job-cancelled"), true, "but cancelled work is real history and stays visible");
  assertEquals(ids.includes("job-archived"), true, "so does archived work");
  assertEquals(
    res.jobs.every((j: Record<string, unknown>) => !("org_id" in j)),
    true,
    "the tenant id is not handed to the client",
  );
});

Deno.test("All tab: a vertical manager browses every vertical, not just the one they manage", async () => {
  const res = await searchAllJobs(
    makeClient(catalogFixtures()),
    new URLSearchParams(),
    viewer({ id: "u-henry", role: "lead_installer", managedVerticals: ["fencing"] }),
    false,
  );
  const types = new Set(res.jobs.map((j: { type: string }) => j.type));

  assertEquals(res.lens, "company");
  assertEquals(types.has("patio"), true, "typed search always reached every vertical; browse now matches it");
  assertEquals(types.has("makesafe"), true);
});

// Scope item 3 again, on the other feed. Note what "unchanged" actually is:
// this browse was never own-only — it has always merged the newest ACTIVE
// company jobs with the viewer's own assignments. What crew must not gain is the
// widening: the full history, including cancelled and archived work.
Deno.test("All tab regression: ordinary crew keep the narrower active-jobs browse", async () => {
  const recorded: RecordedQuery[] = [];
  const res = await searchAllJobs(
    makeClient(catalogFixtures(), recorded),
    new URLSearchParams(),
    viewer({ id: "u-alyx", role: "installer", managedVerticals: [] }),
    false,
  );
  const ids = res.jobs.map((j: { id: string }) => j.id).sort();

  assertEquals(res.lens, "assigned");
  assertEquals(ids, ["job-assigned", "job-never-assigned", "job-quoted"]);
  assertEquals(ids.includes("job-archived"), false, "crew do not gain the full history");
  assertEquals(ids.includes("job-cancelled"), false);
  const seed = recorded.find((q) => q.table === "job_assignments");
  assertEquals(seed?.eq.user_id, "u-alyx", "still seeded from their own assignments, as before");
  const browse = recorded.find((q) => q.table === "jobs" && !q.head);
  assertEquals(
    parseNotInSet(browse?.notIn || "").has("archived"),
    true,
    "and still filtered by the narrower assigned-browse status set",
  );
});

Deno.test("All tab: the company feed pages, and reports an honest total rather than a silent cap", async () => {
  const total = 640;
  const fixtures: Fixtures = {
    assignments: [],
    jobs: Array.from({ length: total }, (_, i) => ({
      id: `job-${String(i).padStart(4, "0")}`,
      type: "fencing",
      status: "quoted",
      job_number: `SWF-${String(i).padStart(4, "0")}`,
      created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    })),
  };

  const first = await searchAllJobs(makeClient(fixtures), new URLSearchParams(), viewer(), true);
  assertEquals(first.jobs.length, 200, "default page");
  assertEquals(first.total, total, "…but the client is told how many exist");
  assertEquals(first.truncated, true);
  assertEquals(first.next_offset, 200);

  const last = await searchAllJobs(
    makeClient(fixtures),
    new URLSearchParams({ offset: "600", page_size: "200" }),
    viewer(),
    true,
  );
  assertEquals(last.jobs.length, 40);
  assertEquals(last.truncated, false, "the final page says so");
  assertEquals(last.next_offset, null);

  const capped = await searchAllJobs(
    makeClient(fixtures),
    new URLSearchParams({ page_size: "5000" }),
    viewer(),
    true,
  );
  assertEquals(capped.page_size, 500, "an oversized page request is clamped, not honoured");
});

Deno.test("All tab: paging never returns the same job on two pages", async () => {
  const total = 300;
  const fixtures: Fixtures = {
    assignments: [],
    jobs: Array.from({ length: total }, (_, i) => ({
      id: `job-${String(i).padStart(4, "0")}`,
      type: "fencing",
      status: "quoted",
      // Deliberately non-unique created_at: without the id tiebreak, rows tied
      // on the sort key can repeat or vanish across a page boundary.
      created_at: "2026-01-01T00:00:00Z",
    })),
  };
  const seen: string[] = [];
  for (let offset = 0; offset < total; offset += 100) {
    const res = await searchAllJobs(
      makeClient(fixtures),
      new URLSearchParams({ offset: String(offset), page_size: "100" }),
      viewer(),
      true,
    );
    seen.push(...res.jobs.map((j: { id: string }) => j.id));
  }
  assertEquals(seen.length, total);
  assertEquals(new Set(seen).size, total, "every job appears exactly once across the pages");
});

Deno.test("search: a capped result keeps truncation honest without looping", async () => {
  const fixtures: Fixtures = {
    assignments: [],
    jobs: Array.from({ length: 501 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i + 300).padStart(12, "0")}`,
      type: "fencing",
      status: "quoted",
      client_name: "needle result",
      created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    })),
  };
  const pages: Array<{ jobs: Job[]; truncated: boolean; next_offset: number | null }> = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const page = await searchAllJobs(
      makeClient(fixtures),
      new URLSearchParams({ q: "needle", page_size: "200", offset: String(offset) }),
      viewer(),
      true,
    );
    pages.push(page as typeof pages[number]);
    assertEquals(page.jobs.length > 0, true, "a continuation never returns an empty page");
    assertEquals(page.truncated, true, "the cap remains visible to the client");
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  assertEquals(pages.length, 3, "the walk reaches the cap and terminates");
  assertEquals(pages.at(-1)?.next_offset, null);
});

Deno.test("All tab: external-ref matches are stable across pages and counted", async () => {
  const externalId = "00000000-0000-0000-0000-000000000099";
  const fixtures: Fixtures = {
    assignments: [],
    jobs: [
      { id: externalId, type: "makesafe", status: "quoted", job_number: "SWMS-EXT", created_at: "2026-01-03T00:00:00Z" },
      { id: "00000000-0000-0000-0000-000000000001", type: "fencing", status: "quoted", job_number: "SWF-1", client_name: "MLB25248 project one", created_at: "2026-01-02T00:00:00Z" },
      { id: "00000000-0000-0000-0000-000000000002", type: "fencing", status: "quoted", job_number: "SWF-2", client_name: "MLB25248 project two", created_at: "2026-01-01T00:00:00Z" },
    ],
    details: [{ job_id: externalId, external_ref: "MLB-25248" }],
  };
  const firstRecorded: RecordedQuery[] = [];
  const first = await searchAllJobs(
    makeClient(fixtures, firstRecorded),
    new URLSearchParams({ q: "MLB25248", page_size: "2" }),
    viewer(),
    true,
  );
  const second = await searchAllJobs(
    makeClient(fixtures),
    new URLSearchParams({ q: "MLB25248", page_size: "2", offset: "2" }),
    viewer(),
    true,
  );
  assertEquals(first.total, 3);
  assertEquals(first.jobs.map((j: { id: string }) => j.id), [externalId, "00000000-0000-0000-0000-000000000001"]);
  assertEquals(second.jobs.map((j: { id: string }) => j.id), ["00000000-0000-0000-0000-000000000002"]);
  assertEquals(new Set([...first.jobs, ...second.jobs].map((j: { id: string }) => j.id)).size, 3);
  const baseReads = firstRecorded.filter((q) => q.table === "jobs" && !q.head && q.or);
  assertEquals(baseReads[0]?.range, [0, 500], "search materializes one bounded result set before slicing");
});

Deno.test("search: multiple external-ref matches respect page size", async () => {
  const extOne = "00000000-0000-0000-0000-000000000101";
  const extTwo = "00000000-0000-0000-0000-000000000102";
  const fixtures: Fixtures = {
    assignments: [],
    jobs: [
      { id: extOne, type: "makesafe", status: "quoted", job_number: "SWMS-EXT-1", created_at: "2026-01-03T00:00:00Z" },
      { id: extTwo, type: "makesafe", status: "quoted", job_number: "SWMS-EXT-2", created_at: "2026-01-02T00:00:00Z" },
      { id: "00000000-0000-0000-0000-000000000103", type: "fencing", status: "quoted", client_name: "MLB25248 base", created_at: "2026-01-01T00:00:00Z" },
    ],
    details: [
      { job_id: extOne, external_ref: "MLB-25248" },
      { job_id: extTwo, external_ref: "MLB-25248" },
    ],
  };
  const pages = await Promise.all([0, 1, 2].map((offset) => searchAllJobs(
    makeClient(fixtures),
    new URLSearchParams({ q: "MLB25248", page_size: "1", offset: String(offset) }),
    viewer(),
    true,
  )));
  assertEquals(pages.every((page) => page.jobs.length <= 1), true);
  assertEquals(new Set(pages.flatMap((page) => page.jobs.map((job: { id: string }) => job.id))).size, 3);
});

Deno.test("search: exact job-number matches rank before newer weaker matches", async () => {
  const fixtures: Fixtures = {
    assignments: [],
    jobs: [
      { id: "00000000-0000-0000-0000-000000000201", type: "fencing", status: "quoted", job_number: "MLB25248", created_at: "2020-01-01T00:00:00Z" },
      { id: "00000000-0000-0000-0000-000000000202", type: "fencing", status: "quoted", client_name: "MLB25248 newer", created_at: "2026-01-01T00:00:00Z" },
    ],
  };
  const res = await searchAllJobs(
    makeClient(fixtures),
    new URLSearchParams({ q: "MLB25248", page_size: "1" }),
    viewer(),
    true,
  );
  assertEquals(res.jobs.map((job: { id: string }) => job.id), ["00000000-0000-0000-0000-000000000201"]);
});

// ── Calendar (task item 4) ───────────────────────────────────────────────────
// A calendar can only ever show scheduled/assigned work — that limit is inherent
// to reading `calendar_events` (job_assignments JOIN jobs) and is accepted. What
// matters is that the SERVER adds no window of its own on top of the range the
// caller asks for: history has to be reachable by asking for it.

function calendarFixtures(): Fixtures {
  return {
    assignments: [],
    jobs: [],
    calendar: [
      { assignment_id: "c-2019", job_id: "job-2019", user_id: "u-crew1", job_type: "fencing", scheduled_date: "2019-04-02" },
      { assignment_id: "c-2024", job_id: "job-2024", user_id: "u-crew2", job_type: "makesafe", job_number: "SWMS-11", scheduled_date: "2024-08-14" },
      { assignment_id: "c-patio", job_id: "job-patio", user_id: "u-crew3", job_type: "patio", scheduled_date: "2026-02-02" },
      { assignment_id: "c-decking", job_id: "job-decking", user_id: "u-crew4", job_type: "decking", scheduled_date: "2026-02-03" },
      { assignment_id: "c-cancelled", job_id: "job-x", user_id: "u-crew5", job_type: "fencing", scheduled_date: "2026-02-04", assignment_status: "cancelled" },
      { assignment_id: "c-tenant-b", job_id: "job-b", user_id: "u-crew-b", job_type: "fencing", scheduled_date: "2026-02-05", org_id: TENANT_B },
    ],
  };
}

Deno.test("calendar: the server adds no date floor — asking for 2019 returns 2019", async () => {
  const recorded: RecordedQuery[] = [];
  const res = await tradeCalendarEvents(
    makeClient(calendarFixtures(), recorded),
    new URLSearchParams({ from: "2019-01-01", to: "2026-12-31", mode: "all" }),
    viewer(),
    true,
  );
  const ids = res.events.map((e: { assignment_id: string }) => e.assignment_id).sort();

  assertEquals(ids, ["c-2019", "c-2024", "c-decking", "c-patio"]);
  const query = recorded.find((q) => q.table === "calendar_events");
  assertEquals(query?.lte.scheduled_date, "2026-12-31", "the only date bound is the caller's own range");
  assertEquals(query?.gte.scheduled_date, undefined, "no independent server-side floor");
  assertEquals(
    query?.ors.some((o) => o.str.includes("2019-01-01")),
    true,
    "the requested `from` is applied as the overlap window, nothing narrower",
  );
  assertEquals(res.truncated, false);
});

// Adding patio/decking lanes is a CLIENT change (trade.html registers a fencing
// source only). The server already serves them; this pins that so the follow-up
// stays a one-sided change.
Deno.test("calendar: a dispatcher's Everyone view already carries every vertical", async () => {
  const recorded: RecordedQuery[] = [];
  const res = await tradeCalendarEvents(
    makeClient(calendarFixtures(), recorded),
    new URLSearchParams({ from: "2026-01-01", to: "2026-12-31", mode: "all" }),
    viewer(),
    true,
  );
  const types = new Set(res.events.map((e: { job_type: string }) => e.job_type));

  assertEquals(res.mode, "all");
  assertEquals(types.has("patio"), true, "patio events are served today");
  assertEquals(types.has("decking"), true, "so are decking events");
  const query = recorded.find((q) => q.table === "calendar_events");
  assertEquals(
    query?.ors.some((o) => /job_type/.test(o.str)),
    false,
    "no vertical filter is applied for a dispatcher who asks for no type",
  );
  assertEquals(query?.eq.org_id, TENANT_A, "still tenant-scoped");
  assertEquals(query?.neq.assignment_status, "cancelled");
});

Deno.test("calendar regression: an ordinary installer is still held to their own rows", async () => {
  const recorded: RecordedQuery[] = [];
  const res = await tradeCalendarEvents(
    makeClient(calendarFixtures(), recorded),
    new URLSearchParams({ from: "2019-01-01", to: "2026-12-31", mode: "all" }),
    viewer({ id: "u-crew3", role: "installer", managedVerticals: [] }),
    false,
  );

  assertEquals(res.mode, "mine", "asking for Everyone does not grant it");
  assertEquals(res.events.map((e: { assignment_id: string }) => e.assignment_id), ["c-patio"]);
  const query = recorded.find((q) => q.table === "calendar_events");
  assertEquals(query?.eq.user_id, "u-crew3");
});

Deno.test("All tab: a bad page_size or offset is refused, not silently coerced", async () => {
  const bad: Record<string, string>[] = [
    { page_size: "0" },
    { page_size: "abc" },
    { offset: "-1" },
    { offset: "1.5" },
  ];
  for (const params of bad) {
    let threw = "";
    try {
      await searchAllJobs(makeClient(catalogFixtures()), new URLSearchParams(params), viewer(), true);
    } catch (err) {
      threw = String((err as Error)?.message || "");
    }
    assertEquals(threw !== "", true, `${JSON.stringify(params)} must be refused`);
  }
});
