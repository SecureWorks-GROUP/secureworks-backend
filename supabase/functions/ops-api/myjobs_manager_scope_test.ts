import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _managerBoardVerticals,
  _resolveManagerVisibility,
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
};
type Fixtures = { assignments: Assignment[]; jobs: Job[] };
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
};

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

function resolveQuery(fx: Fixtures, st: RecordedQuery): { data: unknown[]; error: null } {
  if (st.table === "job_assignments") {
    let rows = fx.assignments.slice();
    if (st.eq.user_id != null) rows = rows.filter((a) => a.user_id === st.eq.user_id);
    if (st.neq.status != null) rows = rows.filter((a) => a.status !== st.neq.status);
    if (st.gte != null) rows = rows.filter((a) => a.scheduled_date != null && a.scheduled_date >= st.gte!);
    if (st.lt != null) rows = rows.filter((a) => a.scheduled_date != null && a.scheduled_date < st.lt!);
    // Inner join to jobs (drop job-less rows) + referenced-table or() constrains parent.
    let joined = rows
      .map((a) => ({ a, job: fx.jobs.find((j) => j.id === a.job_id) }))
      .filter((x) => x.job) as { a: Assignment; job: Job }[];
    if (st.eq["jobs.org_id"] != null) {
      joined = joined.filter((x) => jobOrg(x.job) === st.eq["jobs.org_id"]);
    }
    if (st.refOr && st.refOr.referencedTable === "jobs") {
      joined = joined.filter((x) => matchOr(x.job as unknown as Record<string, unknown>, st.refOr!.str));
    }
    if (st.inCol === "job_id" && st.inVals) {
      joined = joined.filter((x) => st.inVals!.includes(x.a.job_id));
    }
    if (st.select.trim() === "job_id") {
      return { data: joined.map(({ a }) => ({ job_id: a.job_id })), error: null };
    }
    const isAdminSelect = String(st.select || "").includes("user:user_id");
    return {
      data: joined.map(({ a, job }) => ({
        id: a.id,
        scheduled_date: a.scheduled_date,
        status: a.status,
        role: a.role ?? "lead",
        assignment_type: a.assignment_type ?? "install",
        crew_name: null,
        notes: null,
        jobs: { ...job },
        ...(isAdminSelect ? { user: { id: a.user_id, name: a.user_name ?? a.user_id } } : {}),
      })),
      error: null,
    };
  }
  if (st.table === "jobs") {
    let rows = fx.jobs.slice();
    if (st.eq.type != null) rows = rows.filter((j) => j.type === st.eq.type);
    if (st.eq.org_id != null) rows = rows.filter((j) => jobOrg(j) === st.eq.org_id);
    if (st.eq.id != null) rows = rows.filter((j) => j.id === st.eq.id);
    if (st.inCol === "id" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.id));
    if (st.inCol === "status" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.status));
    if (st.refOr && st.refOr.referencedTable == null) {
      rows = rows.filter((j) => matchOr(j as unknown as Record<string, unknown>, st.refOr!.str));
    }
    if (st.notIn) {
      const ex = parseNotInSet(st.notIn);
      rows = rows.filter((j) => !ex.has(j.status));
    }
    return { data: rows.map((j) => ({ ...j })), error: null };
  }
  // makesafe_job_details / job_contacts / purchase_orders → not needed by these
  // fencing/patio/installer/dispatcher fixtures.
  return { data: [], error: null };
}

function makeClient(fx: Fixtures, recorded: RecordedQuery[]) {
  function from(table: string) {
    const st: RecordedQuery = {
      table, eq: {}, neq: {}, gte: null, lt: null, refOr: null,
      notIn: null, inCol: null, inVals: null, select: "",
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: (s: string) => { st.select = s; return b; },
      eq: (k: string, v: unknown) => { st.eq[k] = v; return b; },
      neq: (k: string, v: unknown) => { st.neq[k] = v; return b; },
      gte: (k: string, v: string) => { if (k === "scheduled_date") st.gte = v; return b; },
      lt: (k: string, v: string) => { if (k === "scheduled_date") st.lt = v; return b; },
      in: (k: string, arr: unknown[]) => { st.inCol = k; st.inVals = arr; return b; },
      not: (k: string, op: string, v: string) => { if (k === "status" && op === "in") st.notIn = v; return b; },
      or: (s: string, opts?: { referencedTable?: string }) => {
        st.refOr = { str: s, referencedTable: opts?.referencedTable ?? null };
        return b;
      },
      ilike: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => { recorded.push(st); resolve(resolveQuery(fx, st)); },
    };
    return b;
  }
  return { from };
}

// ── grouped-output helpers ───────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
function nonPool(g: any): any[] { return [...g.today, ...g.thisWeek, ...g.upcoming, ...g.recent]; }
// deno-lint-ignore no-explicit-any
function assignedJobIds(g: any): string[] { return nonPool(g).map((a) => a.jobs?.id); }
// deno-lint-ignore no-explicit-any
function assignedUserIds(g: any): string[] { return nonPool(g).map((a) => a.user?.id).filter(Boolean); }
// deno-lint-ignore no-explicit-any
function poolJobIds(g: any): string[] { return (g.makesafePool as any[]).map((a) => a.jobs?.id); }

const TODAY = todayISO();

function fencingFixtures(): Fixtures {
  const OLD_DATE = new Date(Date.now() + 8 * 3600 * 1000 - 60 * 86400 * 1000).toISOString().slice(0, 10);
  return {
    assignments: [
      // Another crew member's fencing assignment (the manager does NOT own it).
      { id: "a-crew-f1", user_id: "u-crew", user_name: "Crew A", status: "scheduled", scheduled_date: TODAY, job_id: "job-f1" },
      // The manager's own fencing assignment.
      { id: "a-henry-f2", user_id: "u-henry", user_name: "Henry", status: "scheduled", scheduled_date: TODAY, job_id: "job-f2" },
      // A patio assignment for someone else — must stay invisible to a fencing manager.
      { id: "a-crew-p1", user_id: "u-crew2", user_name: "Crew B", status: "scheduled", scheduled_date: TODAY, job_id: "job-p1" },
      { id: "a-crew-d1", user_id: "u-deck", user_name: "Deck Crew", status: "scheduled", scheduled_date: TODAY, job_id: "job-d1" },
      { id: "a-crew-ms1", user_id: "u-ms", user_name: "Make Safe Crew", status: "scheduled", scheduled_date: TODAY, job_id: "job-ms1" },
      // Old and null-dated assignments must still occupy crew-ready jobs even
      // though they stay outside the 30-day manager display window.
      { id: "a-old-f4", user_id: "u-crew3", user_name: "Crew C", status: "scheduled", scheduled_date: OLD_DATE, job_id: "job-f4" },
      { id: "a-null-f5", user_id: "u-crew4", user_name: "Crew D", status: "scheduled", scheduled_date: null, job_id: "job-f5" },
      // Same vertical, different tenant — must never surface.
      { id: "a-tenant-b", user_id: "u-crew-b", user_name: "Crew B2", status: "scheduled", scheduled_date: TODAY, job_id: "job-f-b" },
    ],
    jobs: [
      { id: "job-f1", type: "fencing", status: "schedule_install", job_number: "SWF-1", site_suburb: "Balga" },
      { id: "job-f2", type: "fencing", status: "in_progress", job_number: "SWF-2", site_suburb: "Dianella" },
      { id: "job-f3", type: "fencing", status: "schedule_install", job_number: "SWF-3", site_suburb: "Morley" }, // truly open
      { id: "job-f4", type: "fencing", status: "schedule_install", job_number: "SWF-26101", site_suburb: "Shenton Park" },
      { id: "job-f5", type: "fencing", status: "scheduled", job_number: "SWF-NULL", site_suburb: "Balcatta" },
      { id: "job-p1", type: "patio", status: "schedule_install", job_number: "SWP-1", site_suburb: "Cannington" },
      { id: "job-d1", type: "decking", status: "schedule_install", job_number: "SWD-1", site_suburb: "Bayswater" },
      { id: "job-ms1", type: "general", status: "accepted", job_number: "SWMS-1", site_suburb: "Midland" },
      { id: "job-f-b", org_id: TENANT_B, type: "fencing", status: "schedule_install", job_number: "SWF-B", site_suburb: "Joondalup" },
    ],
  };
}

// Henry: non-dispatcher, manages fencing only.
const HENRY = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["fencing"] });

// ── 1. mode:'all' now surfaces another crew's in-vertical assignment ─────────
Deno.test("U2b-1: fencing manager mode:'all' now sees ANOTHER crew's fencing assignment (was own-only before)", async () => {
  const recNew: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({ isDispatcher: HENRY.isDispatcher, mode: "all", managedVerticals: ["fencing"] });
  assertEquals(managerScope, ["fencing"]);
  const gNew = await myJobs(
    makeClient(fencingFixtures(), recNew), "u-henry",
    /*showAll*/ false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, managerScope,
  );

  // NEW: both the other crew's job-f1 and the manager's own job-f2 are present,
  // and job-f1 carries the OTHER crew member (u-crew).
  const newAssigned = assignedJobIds(gNew);
  assertEquals(newAssigned.includes("job-f1"), true, "widened set includes other crew's fencing job");
  assertEquals(newAssigned.includes("job-f2"), true, "widened set still includes the manager's own job");
  assertEquals(assignedUserIds(gNew).includes("u-crew"), true, "other crew member is attributed on the card");

  // OLD (pre-U2b): same call with managerScope=[] → own assignments only.
  const recOld: RecordedQuery[] = [];
  const gOld = await myJobs(
    makeClient(fencingFixtures(), recOld), "u-henry",
    false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, [],
  );
  const oldAssigned = assignedJobIds(gOld);
  assertEquals(oldAssigned.includes("job-f2"), true, "old path shows the manager's own job");
  assertEquals(oldAssigned.includes("job-f1"), false, "old path did NOT show other crew's assignment (the gap U2b closes)");
});

// ── 2. the open pool no longer false-lists an already-assigned job ───────────
Deno.test("U2b-2: open pool no longer shows a job already assigned to another crew member as 'available'", async () => {
  const managerScope = _managerBoardVerticals({ isDispatcher: HENRY.isDispatcher, mode: "all", managedVerticals: ["fencing"] });

  // NEW: pool dedupes against the vertical-wide set → job-f1 (assigned to u-crew)
  // is NOT available; only the truly-open job-f3 is.
  const gNew = await myJobs(
    makeClient(fencingFixtures(), []), "u-henry",
    false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, managerScope,
  );
  const newPool = poolJobIds(gNew);
  assertEquals(newPool.includes("job-f1"), false, "assigned-elsewhere job is NOT a false-available card");
  assertEquals(newPool.includes("job-f3"), true, "genuinely-open job still appears in the pool");

  // The all-date occupancy probe also protects the default My Jobs union, so
  // de-duplication no longer depends on the 30-day display assignment set.
  const gMine = await myJobs(
    makeClient(fencingFixtures(), []), "u-henry",
    false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, [],
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
  assertEquals(pool.includes("job-f4"), false, "SWF-26101-shaped old assignment stays occupied");
  assertEquals(pool.includes("job-f5"), false, "null-dated assignment stays occupied");
  assertEquals(pool.includes("job-f3"), true, "genuinely unassigned crew-ready work remains available");
  const occupancy = recorded.find((q) =>
    q.table === "job_assignments" && q.select.trim() === "job_id" && q.inCol === "job_id"
  );
  assertEquals(occupancy?.gte, null, "occupancy probe is deliberately all-date");
});

// ── 5. strict vertical scope: a fencing manager gets no patio anywhere ───────
Deno.test("U2b-5: fencing manager sees ONLY same-tenant fencing — no other vertical or tenant", async () => {
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({ isDispatcher: HENRY.isDispatcher, mode: "all", managedVerticals: ["fencing"] });
  const g = await myJobs(
    makeClient(fencingFixtures(), recorded), "u-henry",
    false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, managerScope,
  );
  // The patio assignment + patio job never surface.
  assertEquals(assignedJobIds(g).includes("job-p1"), false, "no patio assignment leaks onto the fencing board");
  assertEquals(poolJobIds(g).includes("job-p1"), false, "no patio pool card leaks onto the fencing board");
  assertEquals(assignedJobIds(g).includes("job-d1"), false, "no decking assignment leaks onto the fencing board");
  assertEquals(poolJobIds(g).includes("job-d1"), false, "no decking pool card leaks onto the fencing board");
  assertEquals(assignedJobIds(g).includes("job-ms1"), false, "no make-safe assignment leaks onto the fencing board");
  assertEquals(poolJobIds(g).includes("job-ms1"), false, "no make-safe pool card leaks onto the fencing board");
  assertEquals(assignedJobIds(g).includes("job-f-b"), false, "tenant-B assignment never leaks");
  assertEquals(poolJobIds(g).includes("job-f-b"), false, "tenant-B pool card never leaks");
  // The widened assignment query was scoped to fencing only.
  const primary = recorded.find((q) => q.table === "job_assignments" && q.refOr?.referencedTable === "jobs");
  assertEquals(primary?.refOr?.str, "type.eq.fencing", "assignment query is scoped to jobs.type = fencing");
  assertEquals(primary?.eq["jobs.org_id"], TENANT_A, "assignment query is scoped to the viewer tenant");
  // No pool query was issued for the patio type.
  assertEquals(recorded.some((q) => q.table === "jobs" && q.eq.type === "patio"), false, "patio pool is never queried");
  const fencingPool = recorded.find((q) => q.table === "jobs" && q.eq.type === "fencing");
  assertEquals(fencingPool?.eq.org_id, TENANT_A, "pool query is scoped to the viewer tenant");
});

// ── make-safe vertical widening resolves by type OR SWMS- prefix ─────────────
Deno.test("U2b: a make-safe manager's widened query matches jobs.type='makesafe' OR an SWMS- job_number", async () => {
  const hugo = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["makesafe"] });
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({ isDispatcher: hugo.isDispatcher, mode: "all", managedVerticals: ["makesafe"] });
  assertEquals(managerScope, ["makesafe"]);
  await myJobs(
    makeClient({ assignments: [], jobs: [] }, recorded), "u-hugo",
    false, hugo.isDispatcher, hugo.isMakesafeManager, hugo.poolVerticals, managerScope,
  );
  const primary = recorded.find((q) => q.table === "job_assignments" && q.refOr?.referencedTable === "jobs" && q.eq.user_id == null);
  // Mirrors _jobVertical + the open-pool query so SWMS-prefixed jobs are not missed.
  assertEquals(primary?.refOr?.str, "type.eq.makesafe,job_number.ilike.SWMS-%");
});

// ── 3. installer is byte-identical before/after (managerScope is inert) ──────
Deno.test("U2b-3 (regression): an installer is unaffected — mode:'all' and mode:'mine' are identical & own-only", async () => {
  const fx = (): Fixtures => ({
    assignments: [
      { id: "a-inst", user_id: "u-inst", status: "scheduled", scheduled_date: TODAY, job_id: "job-f2" },
      { id: "a-other", user_id: "u-crew", status: "scheduled", scheduled_date: TODAY, job_id: "job-f1" },
    ],
    jobs: [
      { id: "job-f1", type: "fencing", status: "accepted" },
      { id: "job-f2", type: "fencing", status: "accepted" },
    ],
  });
  const inst = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: [] });
  assertEquals(inst.poolVerticals, []);

  // The dispatch computes [] for an installer even on mode:'all' (managed empty).
  const scopeAll = _managerBoardVerticals({ isDispatcher: inst.isDispatcher, mode: "all", managedVerticals: [] });
  assertEquals(scopeAll, []);

  const recAll: RecordedQuery[] = [];
  const gAll = await myJobs(makeClient(fx(), recAll), "u-inst", false, inst.isDispatcher, inst.isMakesafeManager, inst.poolVerticals, scopeAll);
  const gMine = await myJobs(makeClient(fx(), []), "u-inst", false, inst.isDispatcher, inst.isMakesafeManager, inst.poolVerticals, []);

  // mode:'all' path (arg=[]) === mode:'mine' path — byte-identical grouped output.
  assertEquals(gAll, gMine);
  // Own-only: sees just their own job, never the other crew's, never a pool card.
  assertEquals(assignedJobIds(gAll), ["job-f2"]);
  assertEquals(poolJobIds(gAll), []);
  // Proof the manager-scope branch was NOT taken: the primary query is the
  // per-user own-assignments query (eq user_id, no vertical widening).
  const primary = recAll.find((q) => q.table === "job_assignments" && q.lt == null);
  assertEquals(primary?.eq.user_id, "u-inst");
  assertEquals(primary?.refOr, null);
});

// ── 4. dispatcher global see-all is untouched ────────────────────────────────
Deno.test("U2b-4 (regression): a dispatcher keeps the global see-all path across every vertical", async () => {
  const fx: Fixtures = {
    assignments: [
      { id: "a1", user_id: "u-crew", status: "scheduled", scheduled_date: TODAY, job_id: "job-f1" },
      { id: "a2", user_id: "u-henry", status: "scheduled", scheduled_date: TODAY, job_id: "job-p1" },
    ],
    jobs: [
      { id: "job-f1", type: "fencing", status: "accepted" },
      { id: "job-p1", type: "patio", status: "accepted" },
    ],
  };
  const admin = _resolveManagerVisibility({ role: "admin", managedVerticals: [] });
  // Dispatcher board vertical scope is empty — they use showAll, not the widening.
  assertEquals(_managerBoardVerticals({ isDispatcher: admin.isDispatcher, mode: "all", managedVerticals: [] }), []);

  const recorded: RecordedQuery[] = [];
  const showAll = admin.isDispatcher; // mode 'all' → showAll = isDispatcher && mode!=='mine'
  const g = await myJobs(makeClient(fx, recorded), "u-admin", showAll, admin.isDispatcher, admin.isMakesafeManager, admin.poolVerticals, []);

  // Sees every crew's assignment across BOTH verticals (global, unchanged).
  const seen = assignedJobIds(g).sort();
  assertEquals(seen, ["job-f1", "job-p1"]);
  // The primary assignment query is the plain showAll query: no user_id scope,
  // no vertical widening.
  const primary = recorded.find((q) => q.table === "job_assignments" && q.lt == null);
  assertEquals(primary?.eq.user_id, undefined);
  assertEquals(primary?.refOr, null);
});

// ── FIX 1 (ship review): manager's Board must keep the 180-day make-safe backstop ──
// Pre-U2b, a make-safe manager's mode:'all' took the personal path, which RAN the
// B2 backstop. The widened manager path skipped it, so a >30-day make-safe
// allocation vanished from `assignments` AND the open pool re-surfaced its job as
// a false "available" card — double-allocation risk.
Deno.test("FIX1: make-safe manager board runs the 180-day backstop vertical-wide — old allocation shows, not a false pool card", async () => {
  const OLD_DATE = new Date(Date.now() + 8 * 3600 * 1000 - 60 * 86400 * 1000).toISOString().slice(0, 10);
  const fx: Fixtures = {
    assignments: [
      // Another crew's make-safe allocation, 60 days old (outside the 30-day window).
      { id: "a-old-ms", user_id: "u-crew", user_name: "Crew A", status: "scheduled", scheduled_date: OLD_DATE, job_id: "job-ms-old" },
    ],
    jobs: [
      { id: "job-ms-old", type: "makesafe", status: "processing", job_number: "SWMS-100" },
      { id: "job-ms-open", type: "makesafe", status: "accepted", job_number: "SWMS-101" }, // truly open
    ],
  };
  const hugo = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["makesafe"] });
  const managerScope = _managerBoardVerticals({ isDispatcher: hugo.isDispatcher, mode: "all", managedVerticals: ["makesafe"] });
  const recorded: RecordedQuery[] = [];
  const g = await myJobs(
    makeClient(fx, recorded), "u-hugo",
    false, hugo.isDispatcher, hugo.isMakesafeManager, hugo.poolVerticals, managerScope,
  );

  // The >30-day allocation (another crew's) IS on the board…
  assertEquals(assignedJobIds(g).includes("job-ms-old"), true, "backstop surfaces the old allocation on the manager board");
  // …and its job is NOT emitted as a false 'available' pool card; the truly-open one is.
  assertEquals(poolJobIds(g).includes("job-ms-old"), false, "old allocated job is not a false-available card");
  assertEquals(poolJobIds(g).includes("job-ms-open"), true, "genuinely-open make-safe still pools");
  // Shape: the backstop query ran VERTICAL-WIDE (no user_id) over the same
  // make-safe jobs filter, 180d..30d window.
  const backstop = recorded.find((q) => q.table === "job_assignments" && q.lt != null);
  assertEquals(backstop?.eq.user_id, undefined, "manager backstop has no user_id filter");
  assertEquals(backstop?.refOr?.str, "type.eq.makesafe,job_number.ilike.SWMS-%");
});

Deno.test("FIX1: fencing manager unaffected — no make-safe backstop query issued", async () => {
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({ isDispatcher: HENRY.isDispatcher, mode: "all", managedVerticals: ["fencing"] });
  const g = await myJobs(
    makeClient(fencingFixtures(), recorded), "u-henry",
    false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, managerScope,
  );
  assertEquals(recorded.some((q) => q.table === "job_assignments" && q.lt != null), false, "no 180-day backstop query for a fencing-only manager");
  // Board content identical to the U2b contract.
  assertEquals(assignedJobIds(g).includes("job-f1"), true);
  assertEquals(poolJobIds(g).includes("job-f3"), true);
});
