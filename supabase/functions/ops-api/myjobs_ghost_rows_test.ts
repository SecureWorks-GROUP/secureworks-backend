// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _fetchOccupyingAssignmentsForTest,
  _managerBoardVerticals,
  _resolveManagerVisibility,
  myJobs,
} from "./index.ts";

// ── Ghost observer rows never reach the my_jobs feed (2026-08-04 defect) ──────
//
// A ghost row (`job_assignments.is_ghost = true`, `role:'observer'`) mirrors a
// job onto an ops manager's own list and is NOT moved when the crew's real row
// is rescheduled, so it keeps the job's old scheduled_date. Every calendar
// surface reads the `calendar_events` view, which is defined
// `WHERE ja.is_ghost = false`; my_jobs used to select job_assignments raw, so
// it was the one schedule surface that carried ghosts. Any consumer deduping to
// one row per job could then pick the ghost's staler date — the Trade App board
// stale-date defect (SWF-26813, SWF-261042; diagnosis with live evidence in
// secureworks-ux docs/evidence/fencing-board-stale-schedule-2026-08-04/).
//
// These tests pin the fix at source: every job_assignments read that can reach
// the returned feed applies the view's own predicate (`.eq('is_ghost', false)`),
// so my_jobs and calendar_events agree by construction. The structural sweep at
// the bottom is the regression guard the fix promises: a job_assignments query
// added to myJobs later WITHOUT the rule fails here rather than silently
// re-introducing ghosts.

const TENANT_A = "00000000-0000-0000-0000-000000000001";

type Assignment = {
  id: string;
  user_id: string;
  status: string;
  scheduled_date: string | null;
  job_id: string;
  role?: string;
  is_ghost?: boolean;
};
type Job = {
  id: string;
  org_id?: string;
  type: string;
  status: string;
  job_number?: string;
  created_at?: string;
};
type Fixtures = { assignments: Assignment[]; jobs: Job[] };

type RecordedQuery = {
  table: string;
  select: string;
  head: boolean;
  eq: Record<string, unknown>;
  neq: Record<string, unknown>;
  gte: Record<string, string>;
  lt: Record<string, string>;
  notIn: string | null;
  inCol: string | null;
  inVals: unknown[] | null;
  or: { str: string; referencedTable: string | null } | null;
  range: [number, number] | null;
  limit: number | null;
};

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

function resolve(
  fx: Fixtures,
  st: RecordedQuery,
): { data: unknown[] | null; error: null; count?: number } {
  if (st.table === "job_assignments") {
    let rows = fx.assignments.slice();
    // The predicate under test — the mock honours it exactly as PostgREST
    // would against the live `boolean NOT NULL DEFAULT false` column.
    if (st.eq.is_ghost != null) {
      rows = rows.filter((a) => Boolean(a.is_ghost) === st.eq.is_ghost);
    }
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
    if (st.gte.scheduled_date != null) {
      rows = rows.filter((a) =>
        a.scheduled_date != null && a.scheduled_date >= st.gte.scheduled_date
      );
    }
    if (st.lt.scheduled_date != null) {
      rows = rows.filter((a) =>
        a.scheduled_date != null && a.scheduled_date < st.lt.scheduled_date
      );
    }
    let joined = rows
      .map((a) => ({ a, job: fx.jobs.find((j) => j.id === a.job_id) }))
      .filter((x) => x.job) as { a: Assignment; job: Job }[];
    if (st.eq["jobs.org_id"] != null) {
      joined = joined.filter((x) =>
        (x.job.org_id || TENANT_A) === st.eq["jobs.org_id"]
      );
    }
    if (st.or && st.or.referencedTable === "jobs") {
      joined = joined.filter((x) =>
        matchOr(x.job as unknown as Record<string, unknown>, st.or!.str)
      );
    }
    if (st.inCol === "job_id" && st.inVals) {
      // The occupancy probe.
      return {
        data: page(
          joined
            .filter((x) => st.inVals!.includes(x.a.job_id))
            .map(({ a }) => ({
              id: a.id,
              job_id: a.job_id,
              scheduled_date: a.scheduled_date,
              status: a.status,
              role: a.role ?? "lead",
              assignment_type: "install",
              user: { id: a.user_id, name: a.user_id },
            })),
          st,
        ),
        error: null,
      };
    }
    const isAdminSelect = st.select.includes("user:user_id");
    return {
      data: page(
        joined.map(({ a, job }) => ({
          id: a.id,
          scheduled_date: a.scheduled_date,
          status: a.status,
          role: a.role ?? "lead",
          assignment_type: "install",
          jobs: { ...job },
          ...(isAdminSelect
            ? { user: { id: a.user_id, name: a.user_id } }
            : {}),
        })),
        st,
      ),
      error: null,
    };
  }
  if (st.table === "jobs") {
    let rows = fx.jobs.slice();
    if (st.eq.org_id != null) {
      rows = rows.filter((j) => (j.org_id || TENANT_A) === st.eq.org_id);
    }
    if (st.eq.type != null) rows = rows.filter((j) => j.type === st.eq.type);
    if (st.inCol === "id" && st.inVals) {
      rows = rows.filter((j) => st.inVals!.includes(j.id));
    }
    if (st.or && st.or.referencedTable == null) {
      rows = rows.filter((j) =>
        matchOr(j as unknown as Record<string, unknown>, st.or!.str)
      );
    }
    if (st.notIn) {
      const excluded = parseNotInSet(st.notIn);
      rows = rows.filter((j) => !excluded.has(j.status));
    }
    if (st.head) return { data: null, error: null, count: rows.length };
    return { data: page(rows.map((j) => ({ ...j })), st), error: null };
  }
  return { data: [], error: null };
}

function makeClient(fx: Fixtures, recorded: RecordedQuery[] = []) {
  function from(table: string) {
    const st: RecordedQuery = {
      table,
      select: "",
      head: false,
      eq: {},
      neq: {},
      gte: {},
      lt: {},
      notIn: null,
      inCol: null,
      inVals: null,
      or: null,
      range: null,
      limit: null,
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: (s: string, opts?: { count?: string; head?: boolean }) => {
        st.select = s;
        if (opts?.head) st.head = true;
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
        st.gte[k] = v;
        return b;
      },
      lte: () => b,
      lt: (k: string, v: string) => {
        st.lt[k] = v;
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
        st.or = { str: s, referencedTable: opts?.referencedTable ?? null };
        return b;
      },
      ilike: () => b,
      order: () => b,
      limit: (n: number) => {
        st.limit = n;
        return b;
      },
      range: (lo: number, hi: number) => {
        st.range = [lo, hi];
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (done: any) => {
        recorded.push(st);
        done(resolve(fx, st));
      },
    };
    return b;
  }
  return { from };
}

// deno-lint-ignore no-explicit-any
function feedRows(g: any): any[] {
  return [
    ...g.today,
    ...g.thisWeek,
    ...g.upcoming,
    ...g.recent,
    ...(g.unscheduled || []),
    ...(g.makesafePool || []),
  ];
}

const DISPATCHER = _resolveManagerVisibility({
  role: "admin",
  managedVerticals: ["makesafe", "fencing", "patio", "decking"],
});
const FENCING_MANAGER = _resolveManagerVisibility({
  role: "lead_installer",
  managedVerticals: ["fencing"],
});
const INSTALLER = _resolveManagerVisibility({
  role: "installer",
  managedVerticals: [],
});

// The live SWF-26813 shape (diagnosis, 2026-08-04): the crew's real row was
// rescheduled to the 6th; the ops manager's ghost watcher row kept the 5th.
function repro(): Fixtures {
  return {
    assignments: [
      {
        id: "a-ghost",
        user_id: "u-ops",
        status: "scheduled",
        scheduled_date: "2026-08-05",
        job_id: "job-corrine",
        role: "observer",
        is_ghost: true,
      },
      {
        id: "a-crew",
        user_id: "u-crew",
        status: "scheduled",
        scheduled_date: "2026-08-06",
        job_id: "job-corrine",
        role: "lead_installer",
        is_ghost: false,
      },
    ],
    jobs: [
      {
        id: "job-corrine",
        type: "fencing",
        status: "in_progress",
        job_number: "SWF-26813",
      },
    ],
  };
}

// What the calendar_events view (`WHERE is_ghost = false`) publishes for the
// job — the set my_jobs must now agree with.
function calendarVisibleIds(fx: Fixtures): string[] {
  return fx.assignments.filter((a) => !a.is_ghost).map((a) => a.id).sort();
}

Deno.test("dispatcher Everyone feed agrees with calendar_events: the crew row only, never the stale ghost", async () => {
  const fx = repro();
  const grouped = await myJobs(
    makeClient(fx),
    "u-marnin",
    true,
    DISPATCHER.isDispatcher,
    DISPATCHER.isMakesafeManager,
    DISPATCHER.poolVerticals,
    [],
    TENANT_A,
  );
  const rows = feedRows(grouped);
  assertEquals(
    rows.map((a) => a.id).sort(),
    calendarVisibleIds(fx),
    "the feed and the calendar_events view see the same rows",
  );
  assertEquals(
    rows.every((a) => a.role !== "observer"),
    true,
    "no observer row reaches the feed",
  );
  assertEquals(
    rows.map((a) => a.scheduled_date),
    ["2026-08-06"],
    "so a per-job dedupe can only ever pick the real crew date",
  );
});

Deno.test("fencing manager Board feed excludes the ghost row", async () => {
  const fx = repro();
  const managerScope = _managerBoardVerticals({
    isDispatcher: FENCING_MANAGER.isDispatcher,
    mode: "all",
    managedVerticals: ["fencing"],
  });
  const grouped = await myJobs(
    makeClient(fx),
    "u-henry",
    false,
    FENCING_MANAGER.isDispatcher,
    FENCING_MANAGER.isMakesafeManager,
    FENCING_MANAGER.poolVerticals,
    managerScope,
    TENANT_A,
  );
  assertEquals(
    feedRows(grouped).map((a) => a.id).sort(),
    calendarVisibleIds(fx),
  );
});

Deno.test("personal feed: the watcher's own ghost row is not their field work", async () => {
  // The ghost row carries the ops manager's OWN user_id, so the personal path
  // is the one place a ghost targets the caller directly. It must still be
  // excluded: a watcher row is not an allocation, and it is invisible on every
  // calendar, so surfacing it here re-creates the cross-surface disagreement.
  const grouped = await myJobs(
    makeClient(repro()),
    "u-ops",
    false,
    INSTALLER.isDispatcher,
    INSTALLER.isMakesafeManager,
    INSTALLER.poolVerticals,
    [],
    TENANT_A,
  );
  assertEquals(
    feedRows(grouped),
    [],
    "a user whose only row on the job is a ghost gets no card for it",
  );
});

Deno.test("occupancy probe: a ghost row can neither hold a pool job nor become its recovered card", async () => {
  // On the personal lens the probe PREFERS the viewer's own row, and the
  // winning row is emitted verbatim by occupiedPoolAssignmentCard — so before
  // the rule, the ops manager's stale ghost row would beat the crew row and
  // become their card. With the rule the ghost is excluded before the pick.
  const recorded: RecordedQuery[] = [];
  const byJobId = await _fetchOccupyingAssignmentsForTest(
    makeClient(repro(), recorded),
    ["job-corrine"],
    "u-ops",
    "vertical",
  );
  const winner = byJobId.get("job-corrine");
  assertEquals(winner?.id, "a-crew", "the crew row holds the job");
  assertEquals(winner?.role !== "observer", true);
  const probe = recorded.find((q) => q.table === "job_assignments");
  assertEquals(probe?.eq.is_ghost, false, "the probe applies the view's rule");
});

Deno.test("structural guard: every job_assignments read that feeds my_jobs carries the calendar_events rule", async () => {
  // Runs every myJobs branch (dispatcher full-range, manager rolling + fencing
  // paged, personal + make-safe backstop) plus the occupancy probe, and
  // requires `.eq('is_ghost', false)` on EVERY job_assignments query each
  // issued. A read added to myJobs later without the rule fails here.
  const runs: Array<[string, RecordedQuery[]]> = [];

  const dispatcherRecorded: RecordedQuery[] = [];
  await myJobs(
    makeClient(repro(), dispatcherRecorded),
    "u-marnin",
    true,
    DISPATCHER.isDispatcher,
    DISPATCHER.isMakesafeManager,
    DISPATCHER.poolVerticals,
    [],
    TENANT_A,
  );
  runs.push(["dispatcher", dispatcherRecorded]);

  const managerRecorded: RecordedQuery[] = [];
  await myJobs(
    makeClient(repro(), managerRecorded),
    "u-henry",
    false,
    FENCING_MANAGER.isDispatcher,
    FENCING_MANAGER.isMakesafeManager,
    FENCING_MANAGER.poolVerticals,
    _managerBoardVerticals({
      isDispatcher: FENCING_MANAGER.isDispatcher,
      mode: "all",
      managedVerticals: ["fencing", "patio"],
    }),
    TENANT_A,
  );
  runs.push(["manager", managerRecorded]);

  const personalRecorded: RecordedQuery[] = [];
  await myJobs(
    makeClient(repro(), personalRecorded),
    "u-ops",
    false,
    INSTALLER.isDispatcher,
    INSTALLER.isMakesafeManager,
    INSTALLER.poolVerticals,
    [],
    TENANT_A,
  );
  runs.push(["personal", personalRecorded]);

  const probeRecorded: RecordedQuery[] = [];
  await _fetchOccupyingAssignmentsForTest(
    makeClient(repro(), probeRecorded),
    ["job-corrine"],
    "",
    "vertical",
  );
  runs.push(["occupancy-probe", probeRecorded]);

  for (const [label, recorded] of runs) {
    const reads = recorded.filter((q) => q.table === "job_assignments");
    assertEquals(
      reads.length > 0,
      true,
      `${label}: the run must actually read job_assignments`,
    );
    for (const q of reads) {
      assertEquals(
        q.eq.is_ghost,
        false,
        `${label}: a job_assignments read is missing .eq('is_ghost', false)`,
      );
    }
  }
});
