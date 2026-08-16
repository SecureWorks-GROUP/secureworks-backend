import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _activeAssignedJobIds,
  _fetchMakesafeReattendStampsForTest,
  _fetchOccupyingAssignmentsForTest,
  _makesafeReattendReleases,
  _managerBoardVerticals,
  _POOL_RELEASING_STATUSES,
  _resolveManagerVisibility,
  _shouldRecoverOccupiedPoolJob,
  myJobs,
} from "./index.ts";

// ── U2b: manager's-Board accuracy (my_jobs mode:'all' for a vertical manager) ──
// Proves the broadening a non-dispatcher vertical manager needs on the Board:
//   1. mode:'all' now returns ANOTHER crew member's in-vertical assignment
//      (the pre-U2b own-only query did not).
//   2. the open pool no longer lists a job already assigned to someone else in
//      that vertical as a false "available" card.
//   3. an installer (no managed_verticals) is byte-identical before/after — the
//      new managerScope arg is fully inert for them.
//   4. a dispatcher's global see-all path is untouched.
//   5. the manager sees ONLY their own verticals (a fencing manager gets no
//      patio assignments and never queries the patio pool).
// The "before" behaviour is reproduced faithfully by calling the SAME myJobs
// with managerScopeVerticals=[] (exactly what the dispatch computed pre-U2b for
// a non-dispatcher), so each test shows the real old→new delta.

// ── A filter-applying Supabase mock (models the embedded jobs join) ──────────
// Unlike a pass-through stub, this actually applies eq/neq/gte/lt, the
// referenced-table or() filter on the embedded jobs relation (inner join), and
// the jobs-table type/status filters — so the widening + pool dedupe are really
// exercised, not assumed. Every issued query is recorded for shape assertions.
type Job = {
  id: string;
  org_id?: string;
  type: string;
  status: string;
  job_number?: string;
  site_suburb?: string;
  client_name?: string;
};
type Assignment = {
  id: string;
  user_id: string;
  user_name?: string;
  status: string;
  scheduled_date: string | null;
  job_id: string;
  assignment_type?: string;
  role?: string;
  completed_at?: string | null;
  updated_at?: string | null;
};
type MakesafeDetail = {
  job_id: string;
  substatus?: string;
  cancel_reason?: string;
  last_reattend_at?: string;
};
type Fixtures = {
  assignments: Assignment[];
  jobs: Job[];
  details?: MakesafeDetail[];
};
type RecordedQuery = {
  table: string;
  eq: Record<string, unknown>;
  neq: Record<string, unknown>;
  gte: string | null;
  lt: string | null;
  refOr: { str: string; referencedTable: string | null } | null;
  notIn: string | null;
  inCol: string | null;
  inVals: unknown[] | null;
  select: string;
  range: [number, number] | null;
};

function pageRows<T>(rows: T[], st: RecordedQuery): T[] {
  if (st.range) return rows.slice(st.range[0], st.range[1] + 1);
  return rows.slice(0, 1000);
}

function todayISO(): string {
  // Mirror getAWSTDate()'s +8h shift; a plain "today" is safely inside the
  // handler's 30-day window regardless of the exact bucket it lands in.
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";

function jobOrg(job: Job): string {
  return job.org_id || TENANT_A;
}

// A referenced/plain or() string is comma-separated `col.op.val`, OR-combined.
function matchOr(job: Record<string, unknown>, orStr: string): boolean {
  return orStr.split(",").some((cond) => {
    const [col, op, ...rest] = cond.split(".");
    const val = rest.join(".");
    const cell = String((job ?? {})[col] ?? "");
    if (op === "eq") return cell === val;
    if (op === "ilike") {
      const pat = val.replace(/%$/, "").toLowerCase();
      return cell.toLowerCase().startsWith(pat); // trailing % = prefix wildcard
    }
    return false;
  });
}

function parseNotInSet(filterStr: string): Set<string> {
  const out = new Set<string>();
  for (const m of filterStr.matchAll(/"([^"]+)"/g)) out.add(m[1]);
  return out;
}

function resolveQuery(
  fx: Fixtures,
  st: RecordedQuery,
): { data: unknown[]; error: null } {
  if (st.table === "job_assignments") {
    let rows = fx.assignments.slice();
    if (st.eq.user_id != null) {
      rows = rows.filter((a) => a.user_id === st.eq.user_id);
    }
    if (st.neq.status != null) {
      rows = rows.filter((a) => a.status !== st.neq.status);
    }
    if (st.notIn) {
      const closed = parseNotInSet(st.notIn);
      rows = rows.filter((a) => !closed.has(a.status));
    }
    if (st.gte != null) {
      rows = rows.filter((a) =>
        a.scheduled_date != null && a.scheduled_date >= st.gte!
      );
    }
    if (st.lt != null) {
      rows = rows.filter((a) =>
        a.scheduled_date != null && a.scheduled_date < st.lt!
      );
    }
    // Inner join to jobs (drop job-less rows) + referenced-table or() constrains parent.
    let joined = rows
      .map((a) => ({ a, job: fx.jobs.find((j) => j.id === a.job_id) }))
      .filter((x) => x.job) as { a: Assignment; job: Job }[];
    if (st.eq["jobs.org_id"] != null) {
      joined = joined.filter((x) => jobOrg(x.job) === st.eq["jobs.org_id"]);
    }
    if (st.refOr && st.refOr.referencedTable === "jobs") {
      joined = joined.filter((x) =>
        matchOr(x.job as unknown as Record<string, unknown>, st.refOr!.str)
      );
    }
    // The occupancy probe is the only query that filters by an explicit job_id
    // list; it returns the occupying assignment, not just the id.
    if (st.inCol === "job_id" && st.inVals) {
      return {
        data: pageRows(
          joined
            .filter((x) => st.inVals!.includes(x.a.job_id))
            .map(({ a }) => ({
              id: a.id,
              job_id: a.job_id,
              scheduled_date: a.scheduled_date,
              scheduled_end: null,
              start_time: null,
              status: a.status,
              role: a.role ?? "lead",
              notes: null,
              assignment_type: a.assignment_type ?? "install",
              crew_name: null,
              completed_at: a.completed_at ?? null,
              clocked_off_at: a.completed_at ?? null,
              updated_at: a.updated_at ?? null,
              user: { id: a.user_id, name: a.user_name ?? a.user_id },
            })),
          st,
        ),
        error: null,
      };
    }
    const isAdminSelect = String(st.select || "").includes("user:user_id");
    return {
      data: pageRows(
        joined.map(({ a, job }) => ({
          id: a.id,
          scheduled_date: a.scheduled_date,
          status: a.status,
          role: a.role ?? "lead",
          assignment_type: a.assignment_type ?? "install",
          crew_name: null,
          notes: null,
          completed_at: a.completed_at ?? null,
          clocked_off_at: a.completed_at ?? null,
          updated_at: a.updated_at ?? null,
          jobs: { ...job },
          ...(isAdminSelect
            ? { user: { id: a.user_id, name: a.user_name ?? a.user_id } }
            : {}),
        })),
        st,
      ),
      error: null,
    };
  }
  if (st.table === "jobs") {
    let rows = fx.jobs.slice();
    if (st.eq.type != null) rows = rows.filter((j) => j.type === st.eq.type);
    if (st.eq.org_id != null) {
      rows = rows.filter((j) => jobOrg(j) === st.eq.org_id);
    }
    if (st.eq.status != null) {
      rows = rows.filter((j) => j.status === st.eq.status);
    }
    if (st.eq.id != null) rows = rows.filter((j) => j.id === st.eq.id);
    if (st.inCol === "id" && st.inVals) {
      rows = rows.filter((j) => st.inVals!.includes(j.id));
    }
    if (st.inCol === "status" && st.inVals) {
      rows = rows.filter((j) => st.inVals!.includes(j.status));
    }
    if (st.refOr && st.refOr.referencedTable == null) {
      rows = rows.filter((j) =>
        matchOr(j as unknown as Record<string, unknown>, st.refOr!.str)
      );
    }
    if (st.notIn) {
      const ex = parseNotInSet(st.notIn);
      rows = rows.filter((j) => !ex.has(j.status));
    }
    return { data: pageRows(rows.map((j) => ({ ...j })), st), error: null };
  }
  if (st.table === "makesafe_job_details") {
    let rows = (fx.details || []).slice();
    if (st.inCol === "job_id" && st.inVals) {
      rows = rows.filter((d) => st.inVals!.includes(d.job_id));
    }
    return { data: pageRows(rows.map((d) => ({ ...d })), st), error: null };
  }
  // job_contacts / purchase_orders → not needed by these fixtures.
  return { data: [], error: null };
}

function makeClient(fx: Fixtures, recorded: RecordedQuery[]) {
  function from(table: string) {
    const st: RecordedQuery = {
      table,
      eq: {},
      neq: {},
      gte: null,
      lt: null,
      refOr: null,
      notIn: null,
      inCol: null,
      inVals: null,
      select: "",
      range: null,
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: (s: string) => {
        st.select = s;
        return b;
      },
      eq: (k: string, v: unknown) => {
        st.eq[k] = v;
        return b;
      },
      neq: (k: string, v: unknown) => {
        st.neq[k] = v;
        return b;
      },
      gte: (k: string, v: string) => {
        if (k === "scheduled_date") st.gte = v;
        return b;
      },
      lt: (k: string, v: string) => {
        if (k === "scheduled_date") st.lt = v;
        return b;
      },
      in: (k: string, arr: unknown[]) => {
        st.inCol = k;
        st.inVals = arr;
        return b;
      },
      not: (k: string, op: string, v: string) => {
        if (k === "status" && op === "in") st.notIn = v;
        return b;
      },
      or: (s: string, opts?: { referencedTable?: string }) => {
        st.refOr = { str: s, referencedTable: opts?.referencedTable ?? null };
        return b;
      },
      ilike: () => b,
      order: () => b,
      limit: () => b,
      range: (from: number, to: number) => {
        st.range = [from, to];
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => {
        recorded.push(st);
        resolve(resolveQuery(fx, st));
      },
    };
    return b;
  }
  return { from };
}

// ── grouped-output helpers ───────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
function nonPool(g: any): any[] {
  return [
    ...g.today,
    ...g.thisWeek,
    ...g.upcoming,
    ...g.recent,
    ...(g.unscheduled || []),
  ];
}
// deno-lint-ignore no-explicit-any
function assignedJobIds(g: any): string[] {
  return nonPool(g).map((a) => a.jobs?.id);
}
// deno-lint-ignore no-explicit-any
function assignedUserIds(g: any): string[] {
  return nonPool(g).map((a) => a.user?.id).filter(Boolean);
}
// deno-lint-ignore no-explicit-any
function poolJobIds(g: any): string[] {
  return (g.makesafePool as any[]).map((a) => a.jobs?.id);
}

const TODAY = todayISO();

function fencingFixtures(): Fixtures {
  const OLD_DATE = new Date(Date.now() + 8 * 3600 * 1000 - 60 * 86400 * 1000)
    .toISOString().slice(0, 10);
  return {
    assignments: [
      // Another crew member's fencing assignment (the manager does NOT own it).
      {
        id: "a-crew-f1",
        user_id: "u-crew",
        user_name: "Crew A",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-f1",
      },
      // The manager's own fencing assignment.
      {
        id: "a-henry-f2",
        user_id: "u-henry",
        user_name: "Henry",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-f2",
      },
      // A patio assignment for someone else — must stay invisible to a fencing manager.
      {
        id: "a-crew-p1",
        user_id: "u-crew2",
        user_name: "Crew B",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-p1",
      },
      {
        id: "a-crew-d1",
        user_id: "u-deck",
        user_name: "Deck Crew",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-d1",
      },
      {
        id: "a-crew-ms1",
        user_id: "u-ms",
        user_name: "Make Safe Crew",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-ms1",
      },
      // Old and null-dated assignments must still occupy crew-ready jobs even
      // though they stay outside the 30-day manager display window.
      {
        id: "a-old-f4",
        user_id: "u-crew3",
        user_name: "Crew C",
        status: "scheduled",
        scheduled_date: OLD_DATE,
        job_id: "job-f4",
      },
      {
        id: "a-null-f5",
        user_id: "u-crew4",
        user_name: "Crew D",
        status: "scheduled",
        scheduled_date: null,
        job_id: "job-f5",
      },
      // A finished fencing visit on a job the office has not advanced yet: it
      // must NOT be re-offered as available.
      {
        id: "a-done-f6",
        user_id: "u-crew8",
        user_name: "Crew H",
        status: "complete",
        scheduled_date: OLD_DATE,
        job_id: "job-f6",
      },
      // The manager's OWN out-of-window allocation — the only occupancy the
      // personal lens may recover.
      {
        id: "a-henry-old-f7",
        user_id: "u-henry",
        user_name: "Henry",
        status: "scheduled",
        scheduled_date: OLD_DATE,
        job_id: "job-f7",
      },
      // Same vertical, different tenant — must never surface.
      {
        id: "a-tenant-b",
        user_id: "u-crew-b",
        user_name: "Crew B2",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-f-b",
      },
    ],
    jobs: [
      {
        id: "job-f1",
        type: "fencing",
        status: "schedule_install",
        job_number: "SWF-1",
        site_suburb: "Balga",
      },
      {
        id: "job-f2",
        type: "fencing",
        status: "in_progress",
        job_number: "SWF-2",
        site_suburb: "Dianella",
      },
      {
        id: "job-f3",
        type: "fencing",
        status: "schedule_install",
        job_number: "SWF-3",
        site_suburb: "Morley",
      }, // truly open
      {
        id: "job-f4",
        type: "fencing",
        status: "schedule_install",
        job_number: "SWF-26101",
        site_suburb: "Shenton Park",
      },
      {
        id: "job-f5",
        type: "fencing",
        status: "scheduled",
        job_number: "SWF-NULL",
        site_suburb: "Balcatta",
      },
      {
        id: "job-f6",
        type: "fencing",
        status: "schedule_install",
        job_number: "SWF-REDO",
        site_suburb: "Yokine",
      },
      {
        id: "job-f7",
        type: "fencing",
        status: "schedule_install",
        job_number: "SWF-MINE",
        site_suburb: "Osborne Park",
      },
      {
        id: "job-p1",
        type: "patio",
        status: "schedule_install",
        job_number: "SWP-1",
        site_suburb: "Cannington",
      },
      {
        id: "job-d1",
        type: "decking",
        status: "schedule_install",
        job_number: "SWD-1",
        site_suburb: "Bayswater",
      },
      {
        id: "job-ms1",
        type: "general",
        status: "accepted",
        job_number: "SWMS-1",
        site_suburb: "Midland",
      },
      {
        id: "job-f-b",
        org_id: TENANT_B,
        type: "fencing",
        status: "schedule_install",
        job_number: "SWF-B",
        site_suburb: "Joondalup",
      },
    ],
  };
}

// Henry: non-dispatcher, manages fencing only.
const HENRY = _resolveManagerVisibility({
  role: "lead_installer",
  managedVerticals: ["fencing"],
});

// ── 1. mode:'all' now surfaces another crew's in-vertical assignment ─────────
Deno.test("U2b-1: fencing manager mode:'all' now sees ANOTHER crew's fencing assignment (was own-only before)", async () => {
  const recNew: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  assertEquals(managerScope, ["fencing"]);
  const gNew = await myJobs(
    makeClient(fencingFixtures(), recNew),
    "u-henry",
    /*showAll*/ false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
  );

  // NEW: both the other crew's job-f1 and the manager's own job-f2 are present,
  // and job-f1 carries the OTHER crew member (u-crew).
  const newAssigned = assignedJobIds(gNew);
  assertEquals(
    newAssigned.includes("job-f1"),
    true,
    "widened set includes other crew's fencing job",
  );
  assertEquals(
    newAssigned.includes("job-f2"),
    true,
    "widened set still includes the manager's own job",
  );
  assertEquals(
    assignedUserIds(gNew).includes("u-crew"),
    true,
    "other crew member is attributed on the card",
  );

  // OLD (pre-U2b): same call with managerScope=[] → own assignments only. The
  // other crew's current job-f1 is neither an assigned card nor a false
  // "available" one; the manager reaches it via mode:'all'.
  const recOld: RecordedQuery[] = [];
  const gOld = await myJobs(
    makeClient(fencingFixtures(), recOld),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    [],
  );
  const primaryOld = recOld.find((q) =>
    q.table === "job_assignments" && q.lt == null && q.inCol == null
  );
  assertEquals(
    primaryOld?.eq.user_id,
    "u-henry",
    "old path's assignment query is own-only",
  );
  assertEquals(primaryOld?.refOr, null, "old path issues no vertical widening");
  const oldAssigned = assignedJobIds(gOld);
  assertEquals(
    oldAssigned.includes("job-f2"),
    true,
    "old path shows the manager's own job",
  );
  assertEquals(
    oldAssigned.includes("job-f1"),
    false,
    "old path did NOT show other crew's assignment (the gap U2b closes)",
  );
  assertEquals(
    poolJobIds(gOld).includes("job-f1"),
    false,
    "job-f1 is never a false-available card",
  );
});

// ── the personal lens keeps other crews' CURRENT work out of the dated lanes ──
// An occupied pool job is never available, but only occupancy the personal feed
// cannot show — and only the viewer's own — is recovered as an assigned card.
Deno.test("personal view recovers only the viewer's own out-of-window allocation", async () => {
  const g = await myJobs(
    makeClient(fencingFixtures(), []),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    [],
  );
  const assigned = nonPool(g);
  const assignedIds = assigned.map((a) => a.jobs?.id);
  const pool = poolJobIds(g);

  // Henry's own 60-day-old allocation: outside the 30-day feed, so recovered.
  const own = assigned.find((a) => a.jobs?.id === "job-f7");
  assertEquals(
    own?.id,
    "a-henry-old-f7",
    "the viewer's own stale allocation still renders",
  );
  assertEquals(own?.user?.id, "u-henry");
  assertEquals(
    pool.includes("job-f7"),
    false,
    "and is never offered as available",
  );

  // Other crews' work — current or stale — stays out of the personal lanes.
  for (const otherCrewJob of ["job-f1", "job-f4", "job-f5"]) {
    assertEquals(
      assignedIds.includes(otherCrewJob),
      false,
      `${otherCrewJob} is not the viewer's work`,
    );
    assertEquals(
      pool.includes(otherCrewJob),
      false,
      `${otherCrewJob} is occupied, never available`,
    );
  }
});

// The generic pool gates on jobs.status alone, and the trade app marks an
// assignment 'complete' without advancing the job — so a finished fencing visit
// must keep holding its job or the crew that just finished it gets its work
// re-offered to a second crew.
Deno.test("a completed assignment still holds a crew-ready fencing job", async () => {
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const recorded: RecordedQuery[] = [];
  const g = await myJobs(
    makeClient(fencingFixtures(), recorded),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
    TENANT_A,
  );
  assertEquals(
    poolJobIds(g).includes("job-f6"),
    false,
    "just-finished fencing work is never re-offered as available",
  );
  const finished = nonPool(g).find((a) => a.jobs?.id === "job-f6");
  assertEquals(
    finished?.id,
    "a-done-f6",
    "it renders as the finishing crew's card",
  );
  assertEquals(finished?.user?.id, "u-crew8");
  const occupancy = recorded.find((q) =>
    q.table === "job_assignments" && q.inCol === "job_id"
  );
  assertEquals(
    parseNotInSet(occupancy?.notIn || "").has("complete"),
    false,
    "a completed row still occupies a vertical job",
  );
  assertEquals(
    parseNotInSet(occupancy?.notIn || "").has("cancelled"),
    true,
    "a dead allocation never occupies",
  );
});

// ── 2. the open pool no longer false-lists an already-assigned job ───────────
Deno.test("U2b-2: open pool no longer shows a job already assigned to another crew member as 'available'", async () => {
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });

  // NEW: pool dedupes against the vertical-wide set → job-f1 (assigned to u-crew)
  // is NOT available; only the truly-open job-f3 is.
  const gNew = await myJobs(
    makeClient(fencingFixtures(), []),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
  );
  const newPool = poolJobIds(gNew);
  assertEquals(
    newPool.includes("job-f1"),
    false,
    "assigned-elsewhere job is NOT a false-available card",
  );
  assertEquals(
    newPool.includes("job-f3"),
    true,
    "genuinely-open job still appears in the pool",
  );

  // The all-date occupancy probe also protects the default My Jobs union, so
  // de-duplication no longer depends on the 30-day display assignment set.
  const gMine = await myJobs(
    makeClient(fencingFixtures(), []),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    [],
  );
  assertEquals(poolJobIds(gMine).includes("job-f1"), false);
});

Deno.test("fencing manager pool never labels old or null-dated assigned work as available", async () => {
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const recorded: RecordedQuery[] = [];
  const grouped = await myJobs(
    makeClient(fencingFixtures(), recorded),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
    TENANT_A,
  );

  const pool = poolJobIds(grouped);
  assertEquals(
    pool.includes("job-f4"),
    false,
    "SWF-26101-shaped old assignment stays occupied",
  );
  assertEquals(
    pool.includes("job-f5"),
    false,
    "null-dated assignment stays occupied",
  );
  assertEquals(
    pool.includes("job-f3"),
    true,
    "genuinely unassigned crew-ready work remains available",
  );

  // Occupied is not the same as invisible: both render as the crew's real
  // allocation, so a stale allocation nobody actioned stays on the board.
  const assigned = nonPool(grouped);
  const f4 = assigned.find((a) => a.jobs?.id === "job-f4");
  const f5 = assigned.find((a) => a.jobs?.id === "job-f5");
  assertEquals(
    f4?.id,
    "a-old-f4",
    "the old allocation renders as its real assignment",
  );
  assertEquals(f4?.user?.id, "u-crew3", "with the occupying crew attributed");
  assertEquals(
    String(f4?.assignment_type || "").endsWith("_open"),
    false,
    "never a synthetic open card",
  );
  assertEquals(
    f5?.id,
    "a-null-f5",
    "the null-dated allocation renders as its real assignment",
  );
  assertEquals(f5?.user?.id, "u-crew4");
  assertEquals(
    f5?.scheduled_date,
    null,
    "its null date is carried, not invented",
  );

  const occupancy = recorded.find((q) =>
    q.table === "job_assignments" && q.inCol === "job_id"
  );
  assertEquals(
    occupancy?.gte,
    null,
    "occupancy probe is deliberately all-date",
  );
  assertEquals(parseNotInSet(occupancy?.notIn || "").has("cancelled"), true);
});

// ── 5. strict vertical scope: a fencing manager gets no patio anywhere ───────
Deno.test("U2b-5: fencing manager sees ONLY same-tenant fencing — no other vertical or tenant", async () => {
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const g = await myJobs(
    makeClient(fencingFixtures(), recorded),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
  );
  // The patio assignment + patio job never surface.
  assertEquals(
    assignedJobIds(g).includes("job-p1"),
    false,
    "no patio assignment leaks onto the fencing board",
  );
  assertEquals(
    poolJobIds(g).includes("job-p1"),
    false,
    "no patio pool card leaks onto the fencing board",
  );
  assertEquals(
    assignedJobIds(g).includes("job-d1"),
    false,
    "no decking assignment leaks onto the fencing board",
  );
  assertEquals(
    poolJobIds(g).includes("job-d1"),
    false,
    "no decking pool card leaks onto the fencing board",
  );
  assertEquals(
    assignedJobIds(g).includes("job-ms1"),
    false,
    "no make-safe assignment leaks onto the fencing board",
  );
  assertEquals(
    poolJobIds(g).includes("job-ms1"),
    false,
    "no make-safe pool card leaks onto the fencing board",
  );
  assertEquals(
    assignedJobIds(g).includes("job-f-b"),
    false,
    "tenant-B assignment never leaks",
  );
  assertEquals(
    poolJobIds(g).includes("job-f-b"),
    false,
    "tenant-B pool card never leaks",
  );
  // The widened assignment query was scoped to fencing only.
  const primary = recorded.find((q) =>
    q.table === "job_assignments" && q.refOr?.referencedTable === "jobs"
  );
  assertEquals(
    primary?.refOr?.str,
    "type.eq.fencing",
    "assignment query is scoped to jobs.type = fencing",
  );
  assertEquals(
    primary?.eq["jobs.org_id"],
    TENANT_A,
    "assignment query is scoped to the viewer tenant",
  );
  // No pool query was issued for the patio type.
  assertEquals(
    recorded.some((q) => q.table === "jobs" && q.eq.type === "patio"),
    false,
    "patio pool is never queried",
  );
  const fencingPool = recorded.find((q) =>
    q.table === "jobs" && q.eq.type === "fencing"
  );
  assertEquals(
    fencingPool?.eq.org_id,
    TENANT_A,
    "pool query is scoped to the viewer tenant",
  );
});

// ── make-safe vertical widening resolves by type OR SWMS- prefix ─────────────
Deno.test("U2b: a make-safe manager's widened query matches jobs.type='makesafe' OR an SWMS- job_number", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  assertEquals(managerScope, ["makesafe"]);
  await myJobs(
    makeClient({ assignments: [], jobs: [] }, recorded),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
  );
  const primary = recorded.find((q) =>
    q.table === "job_assignments" && q.refOr?.referencedTable === "jobs" &&
    q.eq.user_id == null
  );
  // Mirrors _jobVertical + the open-pool query so SWMS-prefixed jobs are not missed.
  assertEquals(primary?.refOr?.str, "type.eq.makesafe,job_number.ilike.SWMS-%");
});

// ── 3. installer is byte-identical before/after (managerScope is inert) ──────
Deno.test("U2b-3 (regression): an installer is unaffected — mode:'all' and mode:'mine' are identical & own-only", async () => {
  const fx = (): Fixtures => ({
    assignments: [
      {
        id: "a-inst",
        user_id: "u-inst",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-f2",
      },
      {
        id: "a-other",
        user_id: "u-crew",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-f1",
      },
    ],
    jobs: [
      { id: "job-f1", type: "fencing", status: "accepted" },
      { id: "job-f2", type: "fencing", status: "accepted" },
    ],
  });
  const inst = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: [],
  });
  assertEquals(inst.poolVerticals, []);

  // The dispatch computes [] for an installer even on mode:'all' (managed empty).
  const scopeAll = _managerBoardVerticals({
    isDispatcher: inst.isDispatcher,
    mode: "all",
    managedVerticals: [],
  });
  assertEquals(scopeAll, []);

  const recAll: RecordedQuery[] = [];
  const gAll = await myJobs(
    makeClient(fx(), recAll),
    "u-inst",
    false,
    inst.isDispatcher,
    inst.isMakesafeManager,
    inst.poolVerticals,
    scopeAll,
  );
  const gMine = await myJobs(
    makeClient(fx(), []),
    "u-inst",
    false,
    inst.isDispatcher,
    inst.isMakesafeManager,
    inst.poolVerticals,
    [],
  );

  // mode:'all' path (arg=[]) === mode:'mine' path — byte-identical grouped output.
  assertEquals(gAll, gMine);
  // Own-only: sees just their own job, never the other crew's, never a pool card.
  assertEquals(assignedJobIds(gAll), ["job-f2"]);
  assertEquals(poolJobIds(gAll), []);
  // Proof the manager-scope branch was NOT taken: the primary query is the
  // per-user own-assignments query (eq user_id, no vertical widening).
  const primary = recAll.find((q) =>
    q.table === "job_assignments" && q.lt == null
  );
  assertEquals(primary?.eq.user_id, "u-inst");
  assertEquals(primary?.refOr, null);
});

// ── 4. dispatcher see-all is untouched, except that it stops at the tenant ──
// "See everything" is every crew and every vertical, NOT every tenant: the pools
// below are all org-scoped, so leaving the dispatcher feed global would hand
// another tenant's whole board to whoever holds a dispatcher role here.
Deno.test("U2b-4 (regression): a dispatcher keeps the see-all path across every vertical, within their tenant", async () => {
  const fx: Fixtures = {
    assignments: [
      {
        id: "a1",
        user_id: "u-crew",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-f1",
      },
      {
        id: "a2",
        user_id: "u-henry",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-p1",
      },
      {
        id: "a3",
        user_id: "u-crew-b",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-b1",
      },
    ],
    jobs: [
      { id: "job-f1", type: "fencing", status: "accepted" },
      { id: "job-p1", type: "patio", status: "accepted" },
      { id: "job-b1", org_id: TENANT_B, type: "fencing", status: "accepted" },
    ],
  };
  const admin = _resolveManagerVisibility({
    role: "admin",
    managedVerticals: [],
  });
  // Dispatcher board vertical scope is empty — they use showAll, not the widening.
  assertEquals(
    _managerBoardVerticals({
      isDispatcher: admin.isDispatcher,
      mode: "all",
      managedVerticals: [],
    }),
    [],
  );

  const recorded: RecordedQuery[] = [];
  const showAll = admin.isDispatcher; // mode 'all' → showAll = isDispatcher && mode!=='mine'
  const g = await myJobs(
    makeClient(fx, recorded),
    "u-admin",
    showAll,
    admin.isDispatcher,
    admin.isMakesafeManager,
    admin.poolVerticals,
    [],
    TENANT_A,
  );

  // Sees every crew's assignment across BOTH verticals (global, unchanged)…
  const seen = assignedJobIds(g).sort();
  assertEquals(seen, ["job-f1", "job-p1"]);
  // …and never the other tenant's.
  assertEquals(
    seen.includes("job-b1"),
    false,
    "a dispatcher's see-all stops at their own tenant",
  );
  // The primary assignment query is the showAll query: no user_id scope, no
  // vertical widening, org-bounded.
  const primary = recorded.find((q) =>
    q.table === "job_assignments" && q.lt == null
  );
  assertEquals(primary?.eq.user_id, undefined);
  assertEquals(primary?.refOr, null);
  assertEquals(
    primary?.eq["jobs.org_id"],
    TENANT_A,
    "the see-all feed is tenant-scoped",
  );
  assertEquals(
    String(primary?.select || "").includes("jobs:job_id!inner"),
    true,
    "via an inner join, so the filter constrains the assignments",
  );
});

// ── FIX 1 (ship review): manager's Board must keep the 180-day make-safe backstop ──
// Pre-U2b, a make-safe manager's mode:'all' took the personal path, which RAN the
// B2 backstop. The widened manager path skipped it, so a >30-day make-safe
// allocation vanished from `assignments` AND the open pool re-surfaced its job as
// a false "available" card — double-allocation risk.
Deno.test("FIX1: make-safe manager board runs the 180-day backstop vertical-wide — old allocation shows, not a false pool card", async () => {
  const OLD_DATE = new Date(Date.now() + 8 * 3600 * 1000 - 60 * 86400 * 1000)
    .toISOString().slice(0, 10);
  const fx: Fixtures = {
    assignments: [
      // Another crew's make-safe allocation, 60 days old (outside the 30-day window).
      {
        id: "a-old-ms",
        user_id: "u-crew",
        user_name: "Crew A",
        status: "scheduled",
        scheduled_date: OLD_DATE,
        job_id: "job-ms-old",
      },
    ],
    jobs: [
      {
        id: "job-ms-old",
        type: "makesafe",
        status: "processing",
        job_number: "SWMS-100",
      },
      {
        id: "job-ms-open",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-101",
      }, // truly open
    ],
  };
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const recorded: RecordedQuery[] = [];
  const g = await myJobs(
    makeClient(fx, recorded),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
  );

  // The >30-day allocation (another crew's) IS on the board…
  assertEquals(
    assignedJobIds(g).includes("job-ms-old"),
    true,
    "backstop surfaces the old allocation on the manager board",
  );
  // …and its job is NOT emitted as a false 'available' pool card; the truly-open one is.
  assertEquals(
    poolJobIds(g).includes("job-ms-old"),
    false,
    "old allocated job is not a false-available card",
  );
  assertEquals(
    poolJobIds(g).includes("job-ms-open"),
    true,
    "genuinely-open make-safe still pools",
  );
  // Shape: the backstop query ran VERTICAL-WIDE (no user_id) over the same
  // make-safe jobs filter, 180d..30d window.
  const backstop = recorded.find((q) =>
    q.table === "job_assignments" && q.lt != null
  );
  assertEquals(
    backstop?.eq.user_id,
    undefined,
    "manager backstop has no user_id filter",
  );
  assertEquals(
    backstop?.refOr?.str,
    "type.eq.makesafe,job_number.ilike.SWMS-%",
  );
});

// A single unbounded probe would hit PostgREST's 1000-row cap (job_assignments
// holds one row per crew PER DATE), and a silently truncated probe re-creates
// the very false-"available" card it exists to prevent.
Deno.test("occupancy probe chunks pool ids and pages past the 1000-row cap", async () => {
  const ids = Array.from({ length: 80 }, (_, i) => `job-${i}`);
  const calls: { ids: string[]; from: number }[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const client = {
    from: () => {
      const st = { ids: [] as string[], from: 0 };
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b,
        in: (_col: string, arr: string[]) => {
          st.ids = arr;
          return b;
        },
        eq: () => b, // the probe's is_ghost exclusion (ghost rows never hold a job)
        neq: () => b,
        not: () => b,
        order: () => b,
        range: (fromRow: number) => {
          st.from = fromRow;
          return b;
        },
        // deno-lint-ignore no-explicit-any
        then: (resolve: any) => {
          calls.push({ ids: st.ids, from: st.from });
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          // Saturate the first page of the first chunk so a second page is required.
          const rows = st.ids.includes("job-0") && st.from === 0
            ? Array.from(
              { length: 1000 },
              () => ({ id: "a-0", job_id: "job-0" }),
            )
            : [{
              id: st.from > 0 ? "a-past-page-1" : `a-${st.ids[0]}`,
              job_id: st.from > 0 ? "job-past-page-1" : st.ids[0],
            }];
          queueMicrotask(() => {
            inFlight--;
            resolve({ data: rows, error: null });
          });
        },
      };
      return b;
    },
  };

  // deno-lint-ignore no-explicit-any
  const occupied = await _fetchOccupyingAssignmentsForTest(client as any, ids);
  assertEquals(
    calls.every((c) => c.ids.length <= 25),
    true,
    "pool ids are chunked well under the row cap",
  );
  assertEquals(
    calls.some((c) => c.from === 1000),
    true,
    "a saturated page is followed by the next range",
  );
  assertEquals(
    occupied.has("job-past-page-1"),
    true,
    "rows past the first page are never silently dropped",
  );
  assertEquals(
    occupied.get("job-past-page-1")?.id,
    "a-past-page-1",
    "the occupying assignment is carried, not just the id",
  );
  assertEquals(occupied.has("job-0"), true);
  // Chunking is only a URL-length guard, so the independent chunks must not
  // serialize into extra round trips on the my_jobs hot path.
  assertEquals(
    peakInFlight > 1,
    true,
    "independent chunks are probed concurrently",
  );
});

Deno.test("occupancy probe picks the latest active assignment for a job", async () => {
  const rows = [
    {
      id: "a-early",
      job_id: "job-x",
      scheduled_date: "2026-01-01",
      user: { id: "u-mine" },
    },
    {
      id: "a-late",
      job_id: "job-x",
      scheduled_date: "2026-06-01",
      user: { id: "u-other" },
    },
    {
      id: "a-null",
      job_id: "job-x",
      scheduled_date: null,
      user: { id: "u-other" },
    },
  ];
  const client = {
    from: () => {
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b,
        in: () => b,
        eq: () => b, // the probe's is_ghost exclusion (ghost rows never hold a job)
        neq: () => b,
        not: () => b,
        order: () => b,
        range: () => b,
        // deno-lint-ignore no-explicit-any
        then: (resolve: any) => resolve({ data: rows, error: null }),
      };
      return b;
    },
  };
  // deno-lint-ignore no-explicit-any
  const occupied = await _fetchOccupyingAssignmentsForTest(client as any, [
    "job-x",
  ]);
  assertEquals(occupied.get("job-x")?.id, "a-late");

  // On the personal lens the viewer's own row represents the job, since it is
  // the only occupancy that lens may recover.
  // deno-lint-ignore no-explicit-any
  const mine = await _fetchOccupyingAssignmentsForTest(
    client as any,
    ["job-x"],
    "u-mine",
  );
  assertEquals(mine.get("job-x")?.id, "a-early");
});

// Callers only reach the predicate for a job the emitted assignment set does not
// already carry, so it tests the lens and nothing else. Second-guessing the
// feed's date window here hid legacy detail-backed make-safes entirely — the
// feed's type/SWMS- filter can never match them at any date.
Deno.test("occupied-pool recovery is scoped by lens", () => {
  const otherCrewOld = {
    scheduled_date: "2026-01-01",
    user: { id: "u-other" },
  };
  const otherCrewNow = {
    scheduled_date: "2026-07-01",
    user: { id: "u-other" },
  };
  const ownNullDated = { scheduled_date: null, user: { id: "u-me" } };

  const recover = (occupying: unknown, lens: "everyone" | "mine") =>
    _shouldRecoverOccupiedPoolJob({ occupying, lens, userId: "u-me" });

  assertEquals(
    recover(otherCrewOld, "everyone"),
    true,
    "Everyone recovers same-tenant managed-vertical stale work",
  );
  assertEquals(
    recover(otherCrewOld, "mine"),
    false,
    "Mine never recovers another crew's work",
  );
  assertEquals(
    recover(ownNullDated, "mine"),
    true,
    "Mine recovers the viewer's own null-dated work",
  );
  assertEquals(
    recover(otherCrewNow, "everyone"),
    true,
    "Everyone recovers work its feed cannot reach at any date",
  );
  assertEquals(
    recover(otherCrewNow, "mine"),
    false,
    "and it never enters the personal dated lanes",
  );
  assertEquals(
    recover(null, "everyone"),
    false,
    "an unoccupied job is not a recovery case",
  );
});

// A make-safe clock_off writes assignment status='complete' and touches nothing
// else, so status alone can never mean "released". Only a durable re-attend stamp
// (reattendMakesafe) that post-dates the visit hands the job back to the pool.
Deno.test("de-dupe seeds release a finished visit only on a durable re-attend stamp", () => {
  const feed = [
    { status: "scheduled", jobs: { id: "job-live" } },
    { status: "in_progress", jobs: { id: "job-working" } },
    {
      status: "complete",
      completed_at: "2026-07-20T02:00:00Z",
      jobs: { id: "job-clocked-off" },
    },
    {
      status: "complete",
      completed_at: "2026-07-10T02:00:00Z",
      jobs: { id: "job-reattended" },
    },
    {
      status: "complete",
      completed_at: "2026-07-24T02:00:00Z",
      jobs: { id: "job-reworked" },
    },
    { status: "cancelled", jobs: { id: "job-dead" } },
    { status: "available", jobs: { id: "job-pool-card" } },
    { status: "scheduled", jobs: null },
  ];
  const reattendAt = {
    "job-reattended": "2026-07-15T04:00:00Z",
    "job-reworked": "2026-07-15T04:00:00Z",
  };

  const makesafeSeed = _activeAssignedJobIds(feed, "makesafe", reattendAt);
  assertEquals(
    makesafeSeed.has("job-clocked-off"),
    true,
    "a plain clock-off keeps holding the make-safe",
  );
  assertEquals(
    makesafeSeed.has("job-reattended"),
    false,
    "a visit that finished before the re-attend releases it",
  );
  assertEquals(
    makesafeSeed.has("job-reworked"),
    true,
    "the re-attend crew's own later visit holds it again",
  );
  assertEquals(makesafeSeed.size, 5);

  // Without the stamp map (the generic pool, and any make-safe whose detail row
  // never reached the caller) nothing finished is ever released.
  assertEquals(
    _activeAssignedJobIds(feed, "makesafe").has("job-reattended"),
    true,
    "no stamp means occupied",
  );
  const verticalSeed = _activeAssignedJobIds(feed, "vertical", reattendAt);
  assertEquals(
    verticalSeed.has("job-reattended"),
    true,
    "vertical: a finished visit always holds the job",
  );
  assertEquals(verticalSeed.size, 6);

  for (const seed of [makesafeSeed, verticalSeed]) {
    assertEquals(seed.has("job-live"), true);
    assertEquals(
      seed.has("job-working"),
      true,
      "in_progress always holds the job",
    );
    assertEquals(
      seed.has("job-dead"),
      false,
      "a dead allocation never holds a job",
    );
    assertEquals(
      seed.has("job-pool-card"),
      true,
      "an already-emitted pool card is not re-emitted",
    );
  }
});

Deno.test("only a dead allocation releases a pool job by status alone", () => {
  assertEquals([..._POOL_RELEASING_STATUSES], ["cancelled"]);
});

Deno.test("a completed make-safe visit releases only on durable re-attend proof", () => {
  const done = (completed_at: string | null) => ({
    status: "complete",
    completed_at,
  });
  const REATTEND = "2026-07-15T04:00:00Z";
  assertEquals(
    _makesafeReattendReleases(done("2026-07-10T02:00:00Z"), null),
    false,
    "no stamp, no release",
  );
  assertEquals(
    _makesafeReattendReleases(done("2026-07-10T02:00:00Z"), ""),
    false,
    "an empty stamp is not proof",
  );
  assertEquals(
    _makesafeReattendReleases(done("2026-07-10T02:00:00Z"), "not-a-date"),
    false,
    "nor is an unreadable one",
  );
  assertEquals(
    _makesafeReattendReleases(done("2026-07-10T02:00:00Z"), REATTEND),
    true,
    "a re-attend after the visit hands the job back",
  );
  assertEquals(
    _makesafeReattendReleases(done("2026-07-20T02:00:00Z"), REATTEND),
    false,
    "a visit finished AFTER the re-attend holds the job",
  );
  assertEquals(
    _makesafeReattendReleases(
      { status: "in_progress", completed_at: null },
      REATTEND,
    ),
    false,
    "only a finished visit is ever a release candidate",
  );

  // clocked_off_at is the other authoritative finishing stamp, and the later of
  // the two is what dates the visit.
  assertEquals(
    _makesafeReattendReleases({
      status: "complete",
      completed_at: null,
      clocked_off_at: "2026-07-10T02:00:00Z",
    }, REATTEND),
    true,
    "a clock-off before the re-attend hands the job back",
  );
  assertEquals(
    _makesafeReattendReleases(
      {
        status: "complete",
        completed_at: "2026-07-10T02:00:00Z",
        clocked_off_at: "2026-07-20T02:00:00Z",
      },
      REATTEND,
    ),
    false,
    "the later of the two finishing stamps decides",
  );

  // A row closed off the trade clock path (ops via update_assignment,
  // closeOpenAssignmentsForJob) carries neither stamp, so nothing on it says when
  // the work finished — it keeps holding.
  assertEquals(
    _makesafeReattendReleases(done(null), REATTEND),
    false,
    "no readable completion timestamp means occupied, never re-offered",
  );
  assertEquals(
    _makesafeReattendReleases({
      status: "complete",
      completed_at: "nonsense",
      clocked_off_at: null,
    }, REATTEND),
    false,
    "and an unparseable one is treated the same way",
  );

  // updated_at is NOT a completion stamp: trg_job_assignments_updated bumps it on
  // every write to the row, so invoicing / acknowledging / editing a long-finished
  // visit must not silently re-date it past the re-attend.
  assertEquals(
    _makesafeReattendReleases(
      {
        status: "complete",
        completed_at: "2026-07-10T02:00:00Z",
        updated_at: "2026-07-20T02:00:00Z",
      },
      REATTEND,
    ),
    true,
    "a later unrelated write never strands a genuinely re-attended make-safe",
  );
  assertEquals(
    _makesafeReattendReleases({
      status: "complete",
      completed_at: null,
      updated_at: "2026-07-10T02:00:00Z",
    }, REATTEND),
    false,
    "and updated_at alone is never proof that the work finished",
  );
});

// The 180-day backstop still leaves two holes the make-safe pool used to fall
// through: an allocation older than the backstop, and one with a NULL
// scheduled_date (dropped by every .gte('scheduled_date') window). Both must be
// treated as occupied, in Everyone AND in the personal union.
function occupiedMakesafeFixtures(): Fixtures {
  const ANCIENT = new Date(Date.now() + 8 * 3600 * 1000 - 300 * 86400 * 1000)
    .toISOString().slice(0, 10);
  const ANCIENT_DONE_AT = new Date(Date.now() - 300 * 86400 * 1000)
    .toISOString();
  const OLD_REATTEND_AT = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
  const REDO_DONE_AT = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const REDO_REATTEND_AT = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
  const JUST_CLOCKED_OFF_AT = new Date(Date.now() - 30 * 60 * 1000)
    .toISOString();
  // Closures off the trade clock path carry no completed_at — only updated_at,
  // which the trigger also bumps for writes that say nothing about the work.
  const DASHBOARD_CLOSED_AT = new Date(Date.now() - 1 * 3600 * 1000)
    .toISOString();
  const AUTO_CLOSED_AT = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
  const INVOICE_STAMPED_AT = new Date(Date.now() - 10 * 60 * 1000)
    .toISOString();
  return {
    assignments: [
      {
        id: "a-ms-ancient",
        user_id: "u-crew5",
        user_name: "Crew E",
        status: "scheduled",
        scheduled_date: ANCIENT,
        job_id: "job-ms-ancient",
      },
      {
        id: "a-ms-null",
        user_id: "u-crew6",
        user_name: "Crew F",
        status: "scheduled",
        scheduled_date: null,
        job_id: "job-ms-null",
      },
      {
        id: "a-ms-cancelled",
        user_id: "u-crew7",
        user_name: "Crew G",
        status: "cancelled",
        scheduled_date: null,
        job_id: "job-ms-open",
      },
      // Re-attend (M-F): cycle 1 closed to 'complete', reattendMakesafe stamped
      // last_reattend_at AFTER it and deliberately creates no new assignment, so
      // the job must pool again.
      {
        id: "a-ms-done",
        user_id: "u-crew8",
        user_name: "Crew H",
        status: "complete",
        scheduled_date: ANCIENT,
        completed_at: ANCIENT_DONE_AT,
        job_id: "job-ms-reattend",
      },
      // The same re-attend at the COMMON timing: the finished visit is still
      // inside the 30-day feed and the 180-day backstop.
      {
        id: "a-ms-redo-done",
        user_id: "u-crew8",
        user_name: "Crew H",
        status: "complete",
        scheduled_date: TODAY,
        completed_at: REDO_DONE_AT,
        job_id: "job-ms-redo",
      },
      // A PLAIN clock_off: status='complete', nothing reopened. The crew has
      // worked it and the report is still outstanding.
      {
        id: "a-ms-clockoff",
        user_id: "u-crew11",
        user_name: "Crew K",
        status: "complete",
        scheduled_date: TODAY,
        completed_at: JUST_CLOCKED_OFF_AT,
        job_id: "job-ms-clockedoff",
      },
      // The same clock_off, beyond every window — reachable only via the probe.
      {
        id: "a-ms-ancient-done",
        user_id: "u-crew12",
        user_name: "Crew L",
        status: "complete",
        scheduled_date: ANCIENT,
        completed_at: ANCIENT_DONE_AT,
        job_id: "job-ms-ancient-done",
      },
      // A re-attend the second crew has already worked: their visit finished
      // AFTER the stamp, so the job is occupied again.
      {
        id: "a-ms-recycle-done",
        user_id: "u-crew13",
        user_name: "Crew M",
        status: "complete",
        scheduled_date: TODAY,
        completed_at: JUST_CLOCKED_OFF_AT,
        job_id: "job-ms-recycled",
      },
      // Re-attended, re-allocated, then closed by ops from the dashboard before
      // the crew ever clocked on: status='complete' with NO finishing stamp at
      // all, so nothing says when the work was done.
      {
        id: "a-ms-dashclosed",
        user_id: "u-crew14",
        user_name: "Crew N",
        status: "complete",
        scheduled_date: TODAY,
        updated_at: DASHBOARD_CLOSED_AT,
        job_id: "job-ms-dashclosed",
      },
      // The same stamp-less shape from closeOpenAssignmentsForJob, whose only
      // timestamp happens to pre-date the re-attend.
      {
        id: "a-ms-autoclosed",
        user_id: "u-crew15",
        user_name: "Crew O",
        status: "complete",
        scheduled_date: ANCIENT,
        updated_at: AUTO_CLOSED_AT,
        job_id: "job-ms-autoclosed",
      },
      // Genuinely finished long before the re-attend, then touched again by the
      // crew's weekly trade invoice (submit_trade_invoice stamps invoiced_in),
      // which bumps updated_at past the re-attend.
      {
        id: "a-ms-invoiced",
        user_id: "u-crew16",
        user_name: "Crew P",
        status: "complete",
        scheduled_date: ANCIENT,
        completed_at: ANCIENT_DONE_AT,
        updated_at: INVOICE_STAMPED_AT,
        job_id: "job-ms-invoiced",
      },
      // The viewer's OWN beyond-backstop allocation.
      {
        id: "a-ms-hugo",
        user_id: "u-hugo",
        user_name: "Hugo",
        status: "scheduled",
        scheduled_date: ANCIENT,
        job_id: "job-ms-mine",
      },
      // A CURRENT allocation on a legacy detail-backed make-safe: the feed's
      // type/SWMS- filter can never carry it, at any date.
      {
        id: "a-ms-legacy",
        user_id: "u-crew9",
        user_name: "Crew I",
        status: "scheduled",
        scheduled_date: TODAY,
        job_id: "job-ms-legacy",
      },
      // Worked, THEN recalled: cancelMakesafe closes only open rows, so this
      // 'complete' row survives and still rides the windowed feed.
      {
        id: "a-ms-worked",
        user_id: "u-crew10",
        user_name: "Crew J",
        status: "complete",
        scheduled_date: TODAY,
        job_id: "job-ms-worked-cancelled",
      },
    ],
    jobs: [
      {
        id: "job-ms-ancient",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-200",
      },
      {
        id: "job-ms-null",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-201",
      },
      {
        id: "job-ms-open",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-202",
      }, // truly open
      {
        id: "job-ms-reattend",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-203",
      },
      {
        id: "job-ms-redo",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-205",
      },
      {
        id: "job-ms-clockedoff",
        type: "makesafe",
        status: "in_progress",
        job_number: "SWMS-207",
      },
      {
        id: "job-ms-ancient-done",
        type: "makesafe",
        status: "in_progress",
        job_number: "SWMS-208",
      },
      {
        id: "job-ms-recycled",
        type: "makesafe",
        status: "in_progress",
        job_number: "SWMS-209",
      },
      {
        id: "job-ms-dashclosed",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-210",
      },
      {
        id: "job-ms-autoclosed",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-211",
      },
      {
        id: "job-ms-invoiced",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-212",
      },
      {
        id: "job-ms-mine",
        type: "makesafe",
        status: "accepted",
        job_number: "SWMS-204",
      },
      // Legacy import: neither type='makesafe' nor an SWMS- number, reachable
      // only through the makesafe_job_details backstop.
      {
        id: "job-ms-legacy",
        type: "general",
        status: "accepted",
        job_number: "LEG-1",
      },
      {
        id: "job-ms-worked-cancelled",
        type: "makesafe",
        status: "cancelled",
        job_number: "SWMS-206",
      },
    ],
    details: [
      { job_id: "job-ms-legacy" },
      { job_id: "job-ms-worked-cancelled", cancel_reason: "builder_recalled" },
      {
        job_id: "job-ms-reattend",
        substatus: "waiting_on_trade_report",
        last_reattend_at: OLD_REATTEND_AT,
      },
      {
        job_id: "job-ms-redo",
        substatus: "waiting_on_trade_report",
        last_reattend_at: REDO_REATTEND_AT,
      },
      // No stamp: the report is simply outstanding after the visit.
      { job_id: "job-ms-clockedoff", substatus: "waiting_on_trade_report" },
      { job_id: "job-ms-ancient-done", substatus: "waiting_on_trade_report" },
      {
        job_id: "job-ms-recycled",
        substatus: "waiting_on_trade_report",
        last_reattend_at: REDO_DONE_AT,
      },
      {
        job_id: "job-ms-dashclosed",
        substatus: "waiting_on_trade_report",
        last_reattend_at: OLD_REATTEND_AT,
      },
      {
        job_id: "job-ms-autoclosed",
        substatus: "waiting_on_trade_report",
        last_reattend_at: OLD_REATTEND_AT,
      },
      {
        job_id: "job-ms-invoiced",
        substatus: "waiting_on_trade_report",
        last_reattend_at: OLD_REATTEND_AT,
      },
    ],
  };
}

// The trade classifier routes on job.status='cancelled', so a job already on the
// board is already in the Cancelled column. The synthetic feed must hand it the
// cancel_* attribution it lacks, not append a second card.
Deno.test("a worked-then-cancelled make-safe shows once, carrying its cancel attribution", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), []),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );
  const cards = [...nonPool(g), ...(g.makesafePool as any[])]
    .filter((a) => a.jobs?.id === "job-ms-worked-cancelled");
  assertEquals(
    cards.length,
    1,
    "the Cancelled column shows the job exactly once",
  );
  assertEquals(
    cards[0].id,
    "a-ms-worked",
    "the crew's real completed card is the one kept",
  );
  assertEquals(
    cards[0].jobs?.status,
    "cancelled",
    "which is what the classifier routes on",
  );
  assertEquals(
    cards[0].jobs?.makesafe_details?.cancel_reason,
    "builder_recalled",
    "and it gains the cancel attribution",
  );
});

Deno.test("a re-attended make-safe returns to the allocatable pool", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), []),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );
  assertEquals(
    poolJobIds(g).includes("job-ms-reattend"),
    true,
    "a re-attended visit releases the make-safe",
  );
  assertEquals(
    assignedJobIds(g).includes("job-ms-reattend"),
    false,
    "the closed visit is not re-rendered as a live card",
  );

  // The common timing: the finished visit is still INSIDE the feed window, so
  // the de-dupe seed — not just the probe — has to honour the re-attend stamp.
  assertEquals(
    poolJobIds(g).includes("job-ms-redo"),
    true,
    "re-attend is allocatable without waiting out the 180-day window",
  );
  const redoCards = nonPool(g).filter((a) => a.jobs?.id === "job-ms-redo");
  assertEquals(
    redoCards.map((a) => a.id),
    ["a-ms-redo-done"],
    "the finished visit still shows once, as history",
  );
  assertEquals(redoCards[0]?.status, "complete");
});

// The regression this rule exists for: clock_off writes assignment
// status='complete' and touches makesafe_job_details not at all, so treating
// 'complete' as "released" re-offered worked make-safes for a second allocation
// AND rendered them twice (pool card + the crew's own feed card).
Deno.test("a clocked-off make-safe stays occupied until an explicit re-attend", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), []),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );

  // In-window: the de-dupe seed has to hold it, or the crew's card and a pool
  // card both render.
  assertEquals(
    poolJobIds(g).includes("job-ms-clockedoff"),
    false,
    "unfinished work is never re-offered as available",
  );
  const workedCards = nonPool(g).filter((a) =>
    a.jobs?.id === "job-ms-clockedoff"
  );
  assertEquals(
    workedCards.map((a) => a.id),
    ["a-ms-clockoff"],
    "it shows exactly once, as the crew's card",
  );

  // Beyond every window: only the occupancy probe can see this one.
  assertEquals(
    poolJobIds(g).includes("job-ms-ancient-done"),
    false,
    "the probe holds it too",
  );
  const ancientDone = nonPool(g).find((a) =>
    a.jobs?.id === "job-ms-ancient-done"
  );
  assertEquals(
    ancientDone?.id,
    "a-ms-ancient-done",
    "recovered as the crew's card rather than vanishing",
  );
  assertEquals(
    ancientDone?.user?.id,
    "u-crew12",
    "with the crew that worked it attributed",
  );

  // A re-attend already worked by the second crew is occupied again.
  assertEquals(
    poolJobIds(g).includes("job-ms-recycled"),
    false,
    "a visit finished after the re-attend re-occupies the job",
  );
  const recycled = nonPool(g).filter((a) => a.jobs?.id === "job-ms-recycled");
  assertEquals(
    recycled.map((a) => a.id),
    ["a-ms-recycle-done"],
    "and still shows exactly once",
  );
});

// Only the trade clock path writes completed_at / clocked_off_at. A row ops
// closed from the dashboard (update_assignment) or closeOpenAssignmentsForJob
// closed carries neither, so nothing on it dates the work — those keep holding
// rather than being guessed at from a mutable column.
Deno.test("a closure with no finishing stamp keeps holding its make-safe", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), []),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );

  // In-window, so the de-dupe seed answers: exactly one card, never a pool card.
  assertEquals(
    poolJobIds(g).includes("job-ms-dashclosed"),
    false,
    "a stamp-less closure is never re-offered",
  );
  const dashClosed = nonPool(g).filter((a) =>
    a.jobs?.id === "job-ms-dashclosed"
  );
  assertEquals(
    dashClosed.map((a) => a.id),
    ["a-ms-dashclosed"],
    "and shows exactly once, as the crew's card",
  );

  // Beyond every window, so the probe answers — same conservative result, even
  // though the row's only timestamp pre-dates the re-attend.
  assertEquals(
    poolJobIds(g).includes("job-ms-autoclosed"),
    false,
    "an older stamp-less closure is held too",
  );
  const autoClosed = nonPool(g).find((a) => a.jobs?.id === "job-ms-autoclosed");
  assertEquals(
    autoClosed?.id,
    "a-ms-autoclosed",
    "recovered as the crew's card rather than vanishing",
  );
});

// updated_at is bumped by trg_job_assignments_updated on EVERY write to the row,
// including ones that say nothing about the work: stamping invoiced_in from the
// crew's weekly trade invoice, acknowledging, confirming, any dashboard edit.
// Dating a visit by it would let those silently strand a re-attended make-safe
// outside the pool, so the manager could never allocate the second visit.
Deno.test("an unrelated later write never strands a re-attended make-safe", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), []),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );

  assertEquals(
    poolJobIds(g).includes("job-ms-invoiced"),
    true,
    "the visit finished before the re-attend, so it is allocatable",
  );
  assertEquals(
    assignedJobIds(g).includes("job-ms-invoiced"),
    false,
    "and the released visit is not also rendered as a live card",
  );
});

// The stamp is the ONLY thing that releases a finished visit, so it must be read
// for exactly the ids being resolved. Piggybacking on the capped, unordered
// legacy detail scan left arbitrary re-attended jobs stranded as occupied.
Deno.test("re-attend stamps are read job-scoped, chunked and paged", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `job-${i}`);
  const calls: {
    table: string;
    select: string;
    inCol: string | null;
    inVals: unknown[];
    from: number;
  }[] = [];
  const client = {
    from: (table: string) => {
      const st = {
        select: "",
        inCol: null as string | null,
        inVals: [] as unknown[],
        from: 0,
      };
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: (s: string) => {
          st.select = s;
          return b;
        },
        in: (col: string, arr: unknown[]) => {
          st.inCol = col;
          st.inVals = arr;
          return b;
        },
        order: () => b,
        range: (fromRow: number) => {
          st.from = fromRow;
          return b;
        },
        // deno-lint-ignore no-explicit-any
        then: (resolve: any) => {
          calls.push({ table, ...st });
          const rows = st.inVals.includes("job-0") && st.from === 0
            ? Array.from(
              { length: 1000 },
              () => ({
                job_id: "job-0",
                last_reattend_at: "2026-07-15T04:00:00Z",
              }),
            )
            : [
              {
                job_id: st.from > 0 ? "job-past-page-1" : String(st.inVals[0]),
                last_reattend_at: "2026-07-15T04:00:00Z",
              },
              { job_id: "job-never-reattended", last_reattend_at: null },
            ];
          queueMicrotask(() => resolve({ data: rows, error: null }));
        },
      };
      return b;
    },
  };

  // deno-lint-ignore no-explicit-any
  const stamps = await _fetchMakesafeReattendStampsForTest(client as any, ids);
  assertEquals(calls.every((c) => c.table === "makesafe_job_details"), true);
  assertEquals(
    calls.every((c) => c.inCol === "job_id"),
    true,
    "the read is scoped to the ids asked about",
  );
  assertEquals(
    calls.every((c) => c.inVals.length <= 25),
    true,
    "ids are chunked well under the URL limit",
  );
  assertEquals(
    calls.every((c) => !c.select.includes("*")),
    true,
    "and asks for only the two columns it uses",
  );
  assertEquals(
    calls.some((c) => c.from === 1000),
    true,
    "a saturated page is followed by the next range",
  );
  assertEquals(
    stamps["job-past-page-1"],
    "2026-07-15T04:00:00Z",
    "rows past the first page are never dropped",
  );
  assertEquals(stamps["job-0"], "2026-07-15T04:00:00Z");
  assertEquals(
    "job-never-reattended" in stamps,
    false,
    "a job that was never re-attended carries no stamp",
  );
});

// A failed stamp read must degrade to "nothing releases", never to a pool card
// for work a crew already holds.
Deno.test("a failed re-attend stamp read keeps finished make-safe work occupied", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const fx = occupiedMakesafeFixtures();
  const base = makeClient(fx, []);
  const client = {
    from: (table: string) => {
      const b = base.from(table);
      // deno-lint-ignore no-explicit-any
      const anyB = b as any;
      if (table !== "makesafe_job_details") return b;
      const guarded = { ...anyB };
      guarded.select = (s: string) => {
        if (
          String(s).includes("last_reattend_at") && !String(s).includes("*")
        ) {
          // deno-lint-ignore no-explicit-any
          const failing: any = {
            in: () => failing,
            order: () => failing,
            range: () => failing,
            // deno-lint-ignore no-explicit-any
            then: (resolve: any) =>
              resolve({ data: null, error: { message: "probe down" } }),
          };
          return failing;
        }
        return anyB.select(s);
      };
      return guarded;
    },
  };

  // deno-lint-ignore no-explicit-any
  const g = await myJobs(
    client as any,
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );
  for (
    const held of [
      "job-ms-reattend",
      "job-ms-redo",
      "job-ms-clockedoff",
      "job-ms-dashclosed",
      "job-ms-autoclosed",
      "job-ms-invoiced",
    ]
  ) {
    assertEquals(
      poolJobIds(g).includes(held),
      false,
      `${held} stays occupied when the stamp read fails`,
    );
  }
  assertEquals(
    poolJobIds(g).includes("job-ms-open"),
    true,
    "genuinely open work is unaffected",
  );
});

// The detail backstop exists for imports the feed's type/SWMS- filter cannot
// match, so "in-window occupancy is already on the feed" is false for them.
Deno.test("a currently-allocated legacy make-safe renders as the crew's card, not nothing", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), []),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );
  const legacy = nonPool(g).find((a) => a.jobs?.id === "job-ms-legacy");
  assertEquals(
    legacy?.id,
    "a-ms-legacy",
    "the allocation renders instead of vanishing",
  );
  assertEquals(
    legacy?.user?.id,
    "u-crew9",
    "with the occupying crew attributed",
  );
  assertEquals(
    poolJobIds(g).includes("job-ms-legacy"),
    false,
    "and is never offered as available",
  );
});

Deno.test("make-safe pool never labels beyond-backstop or null-dated assigned work as available", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const managerScope = _managerBoardVerticals({
    isDispatcher: hugo.isDispatcher,
    mode: "all",
    managedVerticals: ["makesafe"],
  });
  const recorded: RecordedQuery[] = [];
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), recorded),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    managerScope,
    TENANT_A,
  );
  const pool = poolJobIds(g);
  assertEquals(
    pool.includes("job-ms-ancient"),
    false,
    ">180-day allocation stays occupied",
  );
  assertEquals(
    pool.includes("job-ms-null"),
    false,
    "null-dated allocation stays occupied",
  );
  assertEquals(
    pool.includes("job-ms-open"),
    true,
    "a cancelled allocation does not occupy a genuinely open make-safe",
  );

  // B2's rationale still holds: an allocated make-safe never drops off the
  // trade's list silently — it moves from the pool lane to an assigned card.
  const assigned = nonPool(g);
  const ancient = assigned.find((a) => a.jobs?.id === "job-ms-ancient");
  const nullDated = assigned.find((a) => a.jobs?.id === "job-ms-null");
  assertEquals(
    ancient?.id,
    "a-ms-ancient",
    "beyond-backstop allocation still renders",
  );
  assertEquals(
    ancient?.user?.id,
    "u-crew5",
    "with the occupying crew attributed",
  );
  assertEquals(
    nullDated?.id,
    "a-ms-null",
    "null-dated allocation still renders",
  );
  assertEquals(nullDated?.user?.id, "u-crew6");

  const occupancy = recorded.find((q) =>
    q.table === "job_assignments" && q.inCol === "job_id"
  );
  assertEquals(
    occupancy?.gte,
    null,
    "make-safe occupancy probe is deliberately all-date",
  );
  assertEquals(
    parseNotInSet(occupancy?.notIn || "").has("cancelled"),
    true,
    "cancelled assignments never occupy a job",
  );
});

Deno.test("make-safe personal union refuses occupied work as available and recovers only the viewer's own", async () => {
  const hugo = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  });
  const g = await myJobs(
    makeClient(occupiedMakesafeFixtures(), []),
    "u-hugo",
    false,
    hugo.isDispatcher,
    hugo.isMakesafeManager,
    hugo.poolVerticals,
    [],
    TENANT_A,
  );
  const pool = poolJobIds(g);
  assertEquals(
    pool.includes("job-ms-ancient"),
    false,
    "other crew's old allocation is not available in mode:'mine'",
  );
  assertEquals(
    pool.includes("job-ms-null"),
    false,
    "other crew's null-dated allocation is not available in mode:'mine'",
  );
  assertEquals(pool.includes("job-ms-open"), true);
  assertEquals(
    pool.includes("job-ms-mine"),
    false,
    "the viewer's own allocation is not available either",
  );

  const assigned = nonPool(g);
  const assignedIds = assigned.map((a) => a.jobs?.id);
  assertEquals(
    assignedIds.includes("job-ms-ancient"),
    false,
    "other crew's work stays off the personal lanes",
  );
  assertEquals(assignedIds.includes("job-ms-null"), false);
  const own = assigned.find((a) => a.jobs?.id === "job-ms-mine");
  assertEquals(
    own?.id,
    "a-ms-hugo",
    "the viewer's own beyond-backstop allocation still renders",
  );
  assertEquals(own?.user?.id, "u-hugo");
});

Deno.test("FIX1: fencing manager unaffected — no make-safe backstop query issued", async () => {
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const g = await myJobs(
    makeClient(fencingFixtures(), recorded),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
  );
  assertEquals(
    recorded.some((q) => q.table === "job_assignments" && q.lt != null),
    false,
    "no 180-day backstop query for a fencing-only manager",
  );
  // Board content identical to the U2b contract.
  assertEquals(assignedJobIds(g).includes("job-f1"), true);
  assertEquals(poolJobIds(g).includes("job-f3"), true);
});

Deno.test("fencing manager Everyone includes historical, future, and unscheduled assignments", async () => {
  const fixtures: Fixtures = {
    assignments: [
      {
        id: "a-historical",
        user_id: "crew-old",
        status: "complete",
        scheduled_date: "2024-01-08",
        job_id: "job-historical",
      },
      {
        id: "a-future",
        user_id: "crew-future",
        status: "scheduled",
        scheduled_date: "2032-02-09",
        job_id: "job-future",
      },
      {
        id: "a-unscheduled",
        user_id: "crew-unscheduled",
        status: "scheduled",
        scheduled_date: null,
        job_id: "job-unscheduled",
      },
      {
        id: "a-patio",
        user_id: "crew-patio",
        status: "scheduled",
        scheduled_date: "2032-02-09",
        job_id: "job-patio",
      },
      {
        id: "a-tenant-b",
        user_id: "crew-b",
        status: "scheduled",
        scheduled_date: "2032-02-09",
        job_id: "job-tenant-b",
      },
    ],
    jobs: [
      {
        id: "job-historical",
        type: "fencing",
        status: "complete",
        job_number: "SWF-OLD",
      },
      {
        id: "job-future",
        type: "fencing",
        status: "in_progress",
        job_number: "SWF-FUTURE",
      },
      {
        id: "job-unscheduled",
        type: "fencing",
        status: "in_progress",
        job_number: "SWF-UNSCHEDULED",
      },
      {
        id: "job-patio",
        type: "patio",
        status: "in_progress",
        job_number: "SWP-OTHER",
      },
      {
        id: "job-tenant-b",
        org_id: TENANT_B,
        type: "fencing",
        status: "in_progress",
        job_number: "SWF-TENANT-B",
      },
    ],
  };
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const grouped = await myJobs(
    makeClient(fixtures, []),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
    TENANT_A,
  );

  assertEquals(assignedJobIds(grouped).sort(), [
    "job-future",
    "job-historical",
    "job-unscheduled",
  ]);
  assertEquals(
    grouped.unscheduled.map((
      assignment: { jobs?: { id?: string } },
    ) => assignment.jobs?.id),
    ["job-unscheduled"],
  );
});

Deno.test("fencing manager Everyone pages the complete range without duplicates", async () => {
  const count = 1005;
  const fixtures: Fixtures = {
    assignments: Array.from({ length: count }, (_, index) => ({
      id: `a-page-${String(index).padStart(4, "0")}`,
      user_id: `crew-${index}`,
      status: "scheduled",
      scheduled_date: "2032-02-09",
      job_id: `job-page-${String(index).padStart(4, "0")}`,
    })),
    jobs: Array.from({ length: count }, (_, index) => ({
      id: `job-page-${String(index).padStart(4, "0")}`,
      type: "fencing",
      status: "in_progress",
      job_number: `SWF-PAGE-${String(index).padStart(4, "0")}`,
    })),
  };
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const grouped = await myJobs(
    makeClient(fixtures, recorded),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
    TENANT_A,
  );
  const ids = assignedJobIds(grouped);

  assertEquals(ids.length, count);
  assertEquals(new Set(ids).size, count);
  const primaryPages = recorded
    .filter((query) =>
      query.table === "job_assignments" &&
      query.refOr?.str.includes("type.eq.fencing") &&
      query.lt == null
    )
    .map((query) => query.range);
  assertEquals(primaryPages, [[0, 999], [1000, 1999]]);
});

// ── Captain 2026-08-17: "henry should see all fencing jobs" ─────────────────
// Both directions of the ruling, driven end to end through the REAL myJobs with
// the exact arguments the trade dispatch computes for each caller. The lever is
// the existing one — `users.managed_verticals` containing 'fencing' plus the
// Everyone lens (mode:'all') — no new permission concept.
//
// Denominator: every same-tenant fencing job in the fixture that carries a live
// (non-cancelled) assignment, plus every crew-ready fencing job nobody holds.
// Pre-schedule pipeline (quoted / awaiting_deposit / order_materials) is
// deliberately NOT part of "fencing jobs" for the trade list — that exclusion is
// the M3b ruling and is unchanged here.
Deno.test("Captain 2026-08-17: a fencing-vertical lead on Everyone sees EVERY same-tenant fencing job — assigned to anyone, or open", async () => {
  const fx = fencingFixtures();
  const managerScope = _managerBoardVerticals({
    isDispatcher: HENRY.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const g = await myJobs(
    makeClient(fx, []),
    "u-henry",
    false,
    HENRY.isDispatcher,
    HENRY.isMakesafeManager,
    HENRY.poolVerticals,
    managerScope,
  );
  const liveAssignedFencing = new Set(
    fx.assignments
      .filter((a) => a.status !== "cancelled")
      .map((a) => fx.jobs.find((j) => j.id === a.job_id))
      .filter((j) => j && j.type === "fencing" && jobOrg(j) === TENANT_A)
      .map((j) => j!.id),
  );
  const openFencing = fx.jobs
    .filter((j) =>
      j.type === "fencing" && jobOrg(j) === TENANT_A &&
      ["order_confirmed", "schedule_install", "scheduled"].includes(j.status) &&
      !liveAssignedFencing.has(j.id)
    )
    .map((j) => j.id);
  const expected = [...liveAssignedFencing, ...openFencing].sort();
  const seen = [...new Set([...assignedJobIds(g), ...poolJobIds(g)])].sort();
  assertEquals(
    seen,
    expected,
    "Everyone lens = every fencing job, none missing",
  );
  // And nothing that is not fencing.
  for (const id of seen) {
    const job = fx.jobs.find((j) => j.id === id)!;
    assertEquals(job.type, "fencing", `${id} is fencing`);
    assertEquals(jobOrg(job), TENANT_A, `${id} is same-tenant`);
  }
});

Deno.test("Captain 2026-08-17 CONTROL: a person with NO fencing vertical sees none of the other crews' fencing jobs", async () => {
  // Alyx: ordinary installer, no managed vertical, assigned to nothing in the
  // fixture. mode:'all' is a no-op for her (dispatch computes managerScope=[]
  // and poolVerticals=[]).
  const alyx = _resolveManagerVisibility({
    role: "installer",
    managedVerticals: [],
  });
  const gAlyx = await myJobs(
    makeClient(fencingFixtures(), []),
    "u-alyx",
    false,
    alyx.isDispatcher,
    alyx.isMakesafeManager,
    alyx.poolVerticals,
    _managerBoardVerticals({
      isDispatcher: false,
      mode: "all",
      managedVerticals: [],
    }),
  );
  assertEquals(
    assignedJobIds(gAlyx),
    [],
    "no assigned fencing card for an unrelated installer",
  );
  assertEquals(
    poolJobIds(gAlyx),
    [],
    "no fencing pool card for an unrelated installer",
  );

  // Nithin: manages PATIO only. Everyone lens gives him patio, never fencing.
  const nithin = _resolveManagerVisibility({
    role: "lead_installer",
    managedVerticals: ["patio"],
  });
  const gNithin = await myJobs(
    makeClient(fencingFixtures(), []),
    "u-nithin",
    false,
    nithin.isDispatcher,
    nithin.isMakesafeManager,
    nithin.poolVerticals,
    _managerBoardVerticals({
      isDispatcher: false,
      mode: "all",
      managedVerticals: ["patio"],
    }),
  );
  const nithinSeen = [...assignedJobIds(gNithin), ...poolJobIds(gNithin)];
  assertEquals(
    nithinSeen.some((id) => id.startsWith("job-f")),
    false,
    "a patio manager sees no fencing job",
  );
  assertEquals(
    nithinSeen.includes("job-p1"),
    true,
    "…but does see the patio work he manages",
  );
});
