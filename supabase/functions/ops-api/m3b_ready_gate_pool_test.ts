// M3b U1 (D1+G1) — fencing/patio/decking open-pool ready-gate tests.
//
// The generic per-vertical pool is now an INCLUDE filter: only jobs whose
// status is in the crew-ready set (order_confirmed / schedule_install /
// crewless scheduled per gate G1) surface as "available" cards — killing the
// fake 72/76 counts. The make-safe pool keeps its exclude-only filter
// byte-untouched, and assigned-job dedupe is unchanged.
//
// Mock adapted from myjobs_manager_scope_test.ts: it APPLIES eq/in/not and the
// referenced-table or() so the filter change is really exercised, and records
// every query for shape assertions.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _CREW_READY_STATUSES,
  _managerBoardVerticals,
  _resolveManagerVisibility,
  myJobs,
} from "./index.ts";

type Job = { id: string; type: string; status: string; job_number?: string; site_suburb?: string };
type Assignment = { id: string; user_id: string; status: string; scheduled_date: string; job_id: string };
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
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function matchOr(job: Record<string, unknown>, orStr: string): boolean {
  return orStr.split(",").some((cond) => {
    const [col, op, ...rest] = cond.split(".");
    const val = rest.join(".");
    const cell = String((job ?? {})[col] ?? "");
    if (op === "eq") return cell === val;
    if (op === "ilike") return cell.toLowerCase().startsWith(val.replace(/%$/, "").toLowerCase());
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
    if (st.gte != null) rows = rows.filter((a) => a.scheduled_date >= st.gte!);
    if (st.lt != null) rows = rows.filter((a) => a.scheduled_date < st.lt!);
    let joined = rows
      .map((a) => ({ a, job: fx.jobs.find((j) => j.id === a.job_id) }))
      .filter((x) => x.job) as { a: Assignment; job: Job }[];
    if (st.refOr && st.refOr.referencedTable === "jobs") {
      joined = joined.filter((x) => matchOr(x.job as unknown as Record<string, unknown>, st.refOr!.str));
    }
    return {
      data: joined.map(({ a, job }) => ({
        id: a.id, scheduled_date: a.scheduled_date, status: a.status,
        role: "lead", assignment_type: "install", crew_name: null, notes: null,
        jobs: { ...job },
      })),
      error: null,
    };
  }
  if (st.table === "jobs") {
    let rows = fx.jobs.slice();
    if (st.eq.type != null) rows = rows.filter((j) => j.type === st.eq.type);
    if (st.eq.id != null) rows = rows.filter((j) => j.id === st.eq.id);
    if (st.inCol === "status" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.status));
    if (st.inCol === "id" && st.inVals) rows = rows.filter((j) => st.inVals!.includes(j.id));
    if (st.refOr && st.refOr.referencedTable == null) {
      rows = rows.filter((j) => matchOr(j as unknown as Record<string, unknown>, st.refOr!.str));
    }
    if (st.notIn) {
      const ex = parseNotInSet(st.notIn);
      rows = rows.filter((j) => !ex.has(j.status));
    }
    return { data: rows.map((j) => ({ ...j })), error: null };
  }
  return { data: [], error: null }; // makesafe_job_details / purchase_orders / job_contacts
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
      range: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => { recorded.push(st); resolve(resolveQuery(fx, st)); },
    };
    return b;
  }
  return { from };
}

// deno-lint-ignore no-explicit-any
function poolJobIds(g: any): string[] { return (g.makesafePool as any[]).map((a) => a.jobs?.id); }

const TODAY = todayISO();

function fencingFixtures(): Fixtures {
  return {
    assignments: [
      // The manager's own assignment on job-oc-assigned (dedupe case).
      { id: "a-henry", user_id: "u-henry", status: "scheduled", scheduled_date: TODAY, job_id: "job-oc-assigned" },
    ],
    jobs: [
      // Crew-ready, crewless -> MUST pool.
      { id: "job-oc", type: "fencing", status: "order_confirmed", job_number: "SWF-1" },
      { id: "job-si", type: "fencing", status: "schedule_install", job_number: "SWF-2" },
      { id: "job-sc", type: "fencing", status: "scheduled", job_number: "SWF-3" }, // G1: crewless scheduled included
      // Pipeline stages -> must NOT pool (the fake-72 killers).
      { id: "job-ad", type: "fencing", status: "awaiting_deposit", job_number: "SWF-4" },
      { id: "job-om", type: "fencing", status: "order_materials", job_number: "SWF-5" },
      { id: "job-q", type: "fencing", status: "quoted", job_number: "SWF-6" },
      // Crew-ready but ALREADY assigned -> deduped out of the pool.
      { id: "job-oc-assigned", type: "fencing", status: "order_confirmed", job_number: "SWF-7" },
    ],
  };
}

const HENRY = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["fencing"] });

Deno.test("U1: fencing pool shows ONLY the crew-ready set (order_confirmed, schedule_install, crewless scheduled)", async () => {
  const recorded: RecordedQuery[] = [];
  const managerScope = _managerBoardVerticals({ isDispatcher: HENRY.isDispatcher, mode: "all", managedVerticals: ["fencing"] });
  const g = await myJobs(
    makeClient(fencingFixtures(), recorded), "u-henry",
    false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, managerScope,
  );
  const pool = poolJobIds(g);
  assertEquals(pool.includes("job-oc"), true, "order_confirmed pools");
  assertEquals(pool.includes("job-si"), true, "schedule_install pools");
  assertEquals(pool.includes("job-sc"), true, "crewless scheduled pools (G1)");
  assertEquals(pool.includes("job-ad"), false, "awaiting_deposit does NOT pool");
  assertEquals(pool.includes("job-om"), false, "order_materials does NOT pool");
  assertEquals(pool.includes("job-q"), false, "quoted does NOT pool");

  // Shape: the fencing pool query is now an INCLUDE-list on status.
  const poolQuery = recorded.find((q) => q.table === "jobs" && q.eq.type === "fencing");
  assertEquals(poolQuery?.inCol, "status", "pool query filters status by include-list");
  assertEquals(poolQuery?.inVals, [..._CREW_READY_STATUSES]);
  assertEquals(poolQuery?.notIn, null, "no exclude-only filter remains on the generic pool");
});

Deno.test("U1: a crew-ready job that is already assigned stays deduped out of the pool", async () => {
  const managerScope = _managerBoardVerticals({ isDispatcher: HENRY.isDispatcher, mode: "all", managedVerticals: ["fencing"] });
  const g = await myJobs(
    makeClient(fencingFixtures(), []), "u-henry",
    false, HENRY.isDispatcher, HENRY.isMakesafeManager, HENRY.poolVerticals, managerScope,
  );
  assertEquals(poolJobIds(g).includes("job-oc-assigned"), false, "assigned job is not a pool card");
});

Deno.test("U1: make-safe pool is byte-untouched — exclude filter still applies, non-ready statuses still pool", async () => {
  const fx: Fixtures = {
    assignments: [],
    jobs: [
      // 'accepted' is NOT in the crew-ready set but IS a live make-safe -> must
      // still pool for the make-safe manager (their 'New' lane is already honest).
      { id: "job-ms", type: "makesafe", status: "accepted", job_number: "SWMS-1" },
      { id: "job-ms-arch", type: "makesafe", status: "archived", job_number: "SWMS-2" }, // excluded as before
    ],
  };
  const hugo = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["makesafe"] });
  const recorded: RecordedQuery[] = [];
  const g = await myJobs(
    makeClient(fx, recorded), "u-hugo",
    false, hugo.isDispatcher, hugo.isMakesafeManager, hugo.poolVerticals, [],
  );
  const pool = poolJobIds(g);
  assertEquals(pool.includes("job-ms"), true, "accepted make-safe still pools (make-safe untouched)");
  assertEquals(pool.includes("job-ms-arch"), false, "archived still excluded");
  // Shape: the make-safe pool query still uses the EXCLUDE filter, never the include-list.
  const msQuery = recorded.find((q) => q.table === "jobs" && q.refOr?.referencedTable == null && q.refOr?.str.includes("makesafe"));
  assertEquals(msQuery?.notIn != null, true, "make-safe pool keeps its exclude-only filter");
  assertEquals(msQuery?.inCol, null, "make-safe pool has NO status include-list");
});

Deno.test("U1: installer (no managed verticals) issues no pool queries at all", async () => {
  const inst = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: [] });
  const recorded: RecordedQuery[] = [];
  await myJobs(
    makeClient(fencingFixtures(), recorded), "u-inst",
    false, inst.isDispatcher, inst.isMakesafeManager, inst.poolVerticals, [],
  );
  assertEquals(recorded.some((q) => q.table === "jobs" && (q.eq.type != null || q.refOr != null)), false, "no pool query for an installer");
});
