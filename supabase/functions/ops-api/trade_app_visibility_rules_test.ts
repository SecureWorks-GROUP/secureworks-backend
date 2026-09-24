// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Trade App job visibility — the rule table (Captain ruling 2026-09-24).
//
// This is the ONE contract test that pins the rule table itself, across
// every named persona, against the shared decision primitives every Trade
// App surface routes through:
//   - _resolveManagerVisibility  (feeds my_jobs all modes, trade_calendar,
//     my_work_orders, and search_all_jobs' lens/company-scope decision)
//   - resolveTradeJobAccessTier  (the one per-job door every trade_job_detail
//     / add_note / upload_photo / get_service_report / trade_labour_budget
//     surface resolves through)
//   - resolveMakesafeTradeViewer (the make-safe board's own, separate
//     resolver — kept in step with the same rule by construction, see
//     makesafe_board_read_model.ts)
//
// Because every surface is required (item 1) to share these primitives, a
// rule pinned here holds on every surface built on them. End-to-end,
// per-surface coverage (my_jobs pool/window shape, trade_calendar range
// queries, search_all_jobs server-side scoping and paging, the make-safe
// board's own projection) lives in the surface-specific suites this PR also
// updated: myjobs_all_means_all_test.ts, myjobs_manager_scope_test.ts,
// trade_calendar_test.ts, trade_work_order_invoice_test.ts,
// makesafe_board_auth_test.ts, makesafe_board_read_model_test.ts. This file
// additionally drives searchAllJobs and myJobs directly (not just the pure
// resolvers) for the two personas the brief names explicitly: an ordinary
// crew member denied an unallocated make-safe job, and denied search
// results outside their own allocations.
//
// The rule table (per the 2026-09-24 ruling):
//   - See-everything (users.trade_sees_all_jobs): every job, every category,
//     full history, on every surface, including new allocations as they
//     happen. Membership: Shaun, Marnin, Jan, Esther.
//   - Category manager (users.managed_verticals), REGARDLESS OF ROLE: full
//     history of every job in their managed categories, on every surface,
//     plus their own allocations outside those categories.
//   - Everyone else: only jobs they hold (or held) a non-cancelled
//     job_assignments row for — past and present, every status — on every
//     surface including search. Never a company-wide or even an
//     "active-jobs" browse.
//   - Make-safe specifically: the open report door for any signed-in trade
//     (makesafe_open) is retired. Only see-everything or a make-safe
//     category manager may open/allocate an unassigned make-safe job.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resolveManagerVisibility,
  type TradeAuthContext,
  type TradeJobAccessContext,
  myJobs,
  resolveTradeJobAccessTier,
  searchAllJobs,
} from "./index.ts";
import {
  resolveMakesafeTradeViewer,
  type MakesafeBoardViewer,
} from "./makesafe_board_read_model.ts";

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";

// ── The shared job universe every persona is evaluated against ──────────────
const JOB_FENCING = "job-fencing-1";
const JOB_PATIO = "job-patio-1";
const JOB_DECKING = "job-decking-1";
const JOB_MAKESAFE = "job-makesafe-1";
const JOB_TENANT_B = "job-tenant-b-fencing";

type Job = { id: string; org_id: string; type: string; job_number?: string; status: string };
const JOBS: Job[] = [
  { id: JOB_FENCING, org_id: ORG_A, type: "fencing", job_number: "SWF-1", status: "scheduled" },
  { id: JOB_PATIO, org_id: ORG_A, type: "patio", job_number: "SWP-1", status: "scheduled" },
  { id: JOB_DECKING, org_id: ORG_A, type: "decking", job_number: "SWD-1", status: "scheduled" },
  { id: JOB_MAKESAFE, org_id: ORG_A, type: "makesafe", job_number: "SWMS-1", status: "in_progress" },
  { id: JOB_TENANT_B, org_id: ORG_B, type: "fencing", job_number: "SWF-B1", status: "scheduled" },
];

// Ordinary crew's own assignment set: one PAST (300 days ago — proving "past
// and present" reaches well beyond any 30-day floor), one PRESENT.
const CREW_ID = "u-ordinary-crew";
const GHOST_ONLY_ID = "u-ghost-only-ops-manager";
const PAST_DATE = new Date(Date.now() - 300 * 86400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
type Assignment = {
  id: string;
  job_id: string;
  user_id: string;
  status: string;
  scheduled_date: string | null;
  is_ghost?: boolean;
};
const ASSIGNMENTS: Assignment[] = [
  { id: "a-crew-fencing", job_id: JOB_FENCING, user_id: CREW_ID, status: "scheduled", scheduled_date: PAST_DATE },
  { id: "a-crew-patio", job_id: JOB_PATIO, user_id: CREW_ID, status: "scheduled", scheduled_date: TODAY },
  // A cancelled row must never grant access — it is the one exclusion.
  { id: "a-crew-cancelled", job_id: JOB_DECKING, user_id: "u-someone-else", status: "cancelled", scheduled_date: TODAY },
  // A ghost watcher row (auto-mirrored onto an ops manager's account) is a
  // calendar mirror, never an allocation.
  { id: "a-ghost-mirror", job_id: JOB_MAKESAFE, user_id: GHOST_ONLY_ID, status: "scheduled", scheduled_date: TODAY, is_ghost: true },
];

function accessClient(): any {
  return {
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq(_col: string, _val: unknown) {
          this._eq = this._eq || {};
          this._eq[_col] = _val;
          return builder;
        },
        neq(_col: string, _val: unknown) {
          this._neq = this._neq || {};
          this._neq[_col] = _val;
          return builder;
        },
        limit: () => builder,
        async maybeSingle() {
          if (table === "jobs") {
            const row = JOBS.find((j) => j.id === this._eq?.id);
            return { data: row || null, error: null };
          }
          if (table === "job_assignments") {
            const row = ASSIGNMENTS.find((a) =>
              a.job_id === this._eq?.job_id &&
              a.user_id === this._eq?.user_id &&
              a.status !== (this._neq?.status ?? "__none__") &&
              (this._eq?.is_ghost === undefined || (a.is_ghost ?? false) === this._eq.is_ghost)
            );
            return { data: row || null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
}

// ── The named personas ───────────────────────────────────────────────────────
const SEE_EVERYTHING = _resolveManagerVisibility({
  role: "ops_manager",
  managedVerticals: [],
  seeEverything: true,
});
const FENCING_MANAGER_OPS_ROLE = _resolveManagerVisibility({
  role: "ops_manager",
  managedVerticals: ["fencing"],
  seeEverything: false,
});
const FENCING_MANAGER_LEAD = _resolveManagerVisibility({
  role: "lead_installer",
  managedVerticals: ["fencing"],
  seeEverything: false,
});
const PATIO_DECKING_MANAGER = _resolveManagerVisibility({
  role: "lead_installer",
  managedVerticals: ["patio", "decking"],
  seeEverything: false,
});
const MAKESAFE_MANAGER = _resolveManagerVisibility({
  role: "lead_installer",
  managedVerticals: ["makesafe"],
  seeEverything: false,
});
const ORDINARY_CREW = _resolveManagerVisibility({
  role: "crew",
  managedVerticals: [],
  seeEverything: false,
});

const ACCESS_ALL: TradeJobAccessContext = { orgId: ORG_A, managedVerticals: ["makesafe", "fencing", "patio", "decking"] };
const ACCESS_FENCING: TradeJobAccessContext = { orgId: ORG_A, managedVerticals: ["fencing"] };
const ACCESS_PATIO_DECKING: TradeJobAccessContext = { orgId: ORG_A, managedVerticals: ["patio", "decking"] };
const ACCESS_MAKESAFE: TradeJobAccessContext = { orgId: ORG_A, managedVerticals: ["makesafe"] };
const ACCESS_NONE: TradeJobAccessContext = { orgId: ORG_A, managedVerticals: [] };

// ── 1. _resolveManagerVisibility: the see-everything / category-manager
//    split is role-independent ────────────────────────────────────────────
Deno.test("rule table: see-everything sees every category, role-independent", () => {
  assertEquals(SEE_EVERYTHING.isDispatcher, true);
  assertEquals(SEE_EVERYTHING.poolVerticals, ["makesafe"]);
});

Deno.test("rule table: a fencing manager holding an ops_manager role is a CATEGORY manager, not see-everything", () => {
  assertEquals(FENCING_MANAGER_OPS_ROLE.isDispatcher, false, "ops_manager role alone no longer grants see-everything");
  assertEquals(FENCING_MANAGER_OPS_ROLE.poolVerticals, ["fencing"]);
});

Deno.test("rule table: a fencing manager holding lead_installer gets the identical category scope as the ops_manager-titled one", () => {
  assertEquals(FENCING_MANAGER_LEAD.isDispatcher, false);
  assertEquals(FENCING_MANAGER_LEAD.poolVerticals, ["fencing"]);
  assertEquals(FENCING_MANAGER_LEAD.poolVerticals, FENCING_MANAGER_OPS_ROLE.poolVerticals, "role never changes the category answer");
});

Deno.test("rule table: a patio+decking manager gets both categories, canonical order, no fencing/makesafe", () => {
  assertEquals(PATIO_DECKING_MANAGER.isDispatcher, false);
  assertEquals(PATIO_DECKING_MANAGER.poolVerticals, ["patio", "decking"]);
});

Deno.test("rule table: a make-safe manager gets the make-safe pool, not see-everything", () => {
  assertEquals(MAKESAFE_MANAGER.isDispatcher, false);
  assertEquals(MAKESAFE_MANAGER.canSeeMakesafePool, true);
  assertEquals(MAKESAFE_MANAGER.poolVerticals, ["makesafe"]);
});

Deno.test("rule table: ordinary crew has no category pool at all", () => {
  assertEquals(ORDINARY_CREW.isDispatcher, false);
  assertEquals(ORDINARY_CREW.canSeeMakesafePool, false);
  assertEquals(ORDINARY_CREW.poolVerticals, []);
});

// ── 2. resolveTradeJobAccessTier: the per-job door, every job, every persona ─
async function tiers(
  visibility: ReturnType<typeof _resolveManagerVisibility>,
  userId: string,
  access: TradeJobAccessContext,
) {
  const client = accessClient();
  const out: Record<string, string> = {};
  for (const jobId of [JOB_FENCING, JOB_PATIO, JOB_DECKING, JOB_MAKESAFE]) {
    const d = await resolveTradeJobAccessTier(client, jobId, userId, {
      isOffice: visibility.isDispatcher,
      access,
    });
    out[jobId] = d.tier;
  }
  return out;
}

Deno.test("rule table: see-everything is 'office' on every job in every category", async () => {
  const t = await tiers(SEE_EVERYTHING, "u-see-everything", ACCESS_ALL);
  assertEquals(t, {
    [JOB_FENCING]: "office",
    [JOB_PATIO]: "office",
    [JOB_DECKING]: "office",
    [JOB_MAKESAFE]: "office",
  });
});

Deno.test("rule table: a fencing category manager (either role) is division_manager on fencing only, refused elsewhere", async () => {
  for (const visibility of [FENCING_MANAGER_OPS_ROLE, FENCING_MANAGER_LEAD]) {
    const t = await tiers(visibility, "u-fencing-manager", ACCESS_FENCING);
    assertEquals(t, {
      [JOB_FENCING]: "division_manager",
      [JOB_PATIO]: "none",
      [JOB_DECKING]: "none",
      [JOB_MAKESAFE]: "none",
    });
  }
});

Deno.test("rule table: a patio+decking manager is division_manager on both, refused on fencing and make-safe", async () => {
  const t = await tiers(PATIO_DECKING_MANAGER, "u-patio-decking-manager", ACCESS_PATIO_DECKING);
  assertEquals(t, {
    [JOB_FENCING]: "none",
    [JOB_PATIO]: "division_manager",
    [JOB_DECKING]: "division_manager",
    [JOB_MAKESAFE]: "none",
  });
});

Deno.test("rule table: a make-safe manager is division_manager on the make-safe job (never makesafe_open), refused on every other category", async () => {
  const t = await tiers(MAKESAFE_MANAGER, "u-makesafe-manager", ACCESS_MAKESAFE);
  assertEquals(t, {
    [JOB_FENCING]: "none",
    [JOB_PATIO]: "none",
    [JOB_DECKING]: "none",
    [JOB_MAKESAFE]: "division_manager",
  });
});

Deno.test("rule table: ordinary crew is 'allocated' only on jobs they hold an assignment on, 'none' everywhere else — including the unallocated make-safe (retired open door)", async () => {
  const t = await tiers(ORDINARY_CREW, CREW_ID, ACCESS_NONE);
  assertEquals(t, {
    [JOB_FENCING]: "allocated",
    [JOB_PATIO]: "allocated",
    [JOB_DECKING]: "none",
    [JOB_MAKESAFE]: "none",
  }, "the make-safe job is 'none', not 'makesafe_open' — that door is retired");
});

Deno.test("rule table: a cancelled assignment never grants access, for anyone", async () => {
  const client = accessClient();
  const d = await resolveTradeJobAccessTier(client, JOB_DECKING, "u-someone-else", {
    isOffice: false,
    access: ACCESS_NONE,
  });
  assertEquals(d.tier, "none");
});

Deno.test("rule table: quote visibility is exactly office and division_manager — unchanged by this ruling", async () => {
  const client = accessClient();
  const office = await resolveTradeJobAccessTier(client, JOB_FENCING, "x", { isOffice: true, access: ACCESS_ALL });
  const manager = await resolveTradeJobAccessTier(client, JOB_FENCING, "x", { isOffice: false, access: ACCESS_FENCING });
  const allocated = await resolveTradeJobAccessTier(client, JOB_FENCING, CREW_ID, { isOffice: false, access: ACCESS_NONE });
  assertEquals(office.quoteVisible, true);
  assertEquals(manager.quoteVisible, true);
  assertEquals(allocated.quoteVisible, false);
});

// ── 3. resolveMakesafeTradeViewer: the make-safe board's own resolver
//    stays in step with the same rule ───────────────────────────────────────
function boardViewer(overrides: Partial<MakesafeBoardViewer>): MakesafeBoardViewer {
  return { userId: "x", role: "crew", managedVerticals: [], seeEverything: false, ...overrides };
}

Deno.test("rule table: make-safe board — see-everything sees all and may allocate", () => {
  const p = resolveMakesafeTradeViewer(boardViewer({ seeEverything: true }));
  assertEquals(p.sees_all_makesafes, true);
  assertEquals(p.can_allocate, true);
});

Deno.test("rule table: make-safe board — a make-safe category manager sees all and may allocate, role-independent", () => {
  for (const role of ["ops_manager", "lead_installer", "crew"]) {
    const p = resolveMakesafeTradeViewer(boardViewer({ role, managedVerticals: ["makesafe"] }));
    assertEquals(p.sees_all_makesafes, true, role);
    assertEquals(p.can_allocate, true, role);
  }
});

Deno.test("rule table: make-safe board — a fencing-only manager (any role) gets plain allocated_only, no special view-only shape", () => {
  for (const role of ["ops_manager", "lead_installer", "sales"]) {
    const p = resolveMakesafeTradeViewer(boardViewer({ role, managedVerticals: ["fencing"] }));
    assertEquals(p.sees_all_makesafes, false, role);
    assertEquals(p.can_allocate, false, role);
    assertEquals(p.fencing_view_only, false, role);
  }
});

Deno.test("rule table: make-safe board — ordinary crew is allocated_only, may never allocate", () => {
  const p = resolveMakesafeTradeViewer(boardViewer({}));
  assertEquals(p.sees_all_makesafes, false);
  assertEquals(p.can_allocate, false);
});

// ── 4. End-to-end: search_all_jobs and my_jobs for the two personas the
//    brief names explicitly ─────────────────────────────────────────────────

type QueryLog = { table: string; eq: Record<string, unknown>; inVals: unknown[] | null }[];

function surfaceClient(log: QueryLog): any {
  function builder(table: string) {
    const st = {
      select: "",
      eq: {} as Record<string, unknown>,
      inCol: null as string | null,
      inVals: null as unknown[] | null,
      notIn: null as string | null,
      orStr: null as string | null,
    };
    const b: any = {
      select: (s: string) => { st.select = s; return b; },
      eq: (k: string, v: unknown) => { st.eq[k] = v; return b; },
      neq: () => b,
      gte: () => b,
      lt: () => b,
      not: (k: string, op: string, v: string) => { if (k === "status" && op === "in") st.notIn = v; return b; },
      in: (k: string, arr: unknown[]) => { st.inCol = k; st.inVals = arr; return b; },
      or: (s: string) => { st.orStr = s; return b; },
      order: () => b,
      range: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any) => {
        log.push({ table, eq: { ...st.eq }, inVals: st.inVals });
        if (table === "job_assignments") {
          let rows = ASSIGNMENTS.filter((a) =>
            a.user_id === st.eq.user_id && a.status !== "cancelled" &&
            (st.eq.is_ghost === undefined || (a.is_ghost ?? false) === st.eq.is_ghost)
          );
          // myJobs' personal lane applies its own, separately-ruled 30-day
          // recency window via .or(_myJobsPersonalRecencyFilter(floor)) — a
          // plain or() whose grammar is `scheduled_end.gte.<floor>,
          // and(scheduled_end.is.null,scheduled_date.gte.<floor>),
          // scheduled_date.is.null`. The mock must honour it (none of our
          // fixture rows carry scheduled_end) so this file can prove the
          // personal window's out-of-scope status honestly rather than
          // asserting against an unfiltered mock.
          const recencyMatch = st.orStr?.match(/^scheduled_end\.gte\.([^,]+),/);
          if (recencyMatch) {
            const floor = recencyMatch[1];
            rows = rows.filter((a) => a.scheduled_date == null || a.scheduled_date >= floor);
          }
          // The 180-day make-safe backstop's own jobs-embed type filter —
          // never let a non-make-safe assignment ride the backstop.
          if (st.orStr?.includes("type.eq.makesafe")) {
            rows = rows.filter((a) => JOBS.find((j) => j.id === a.job_id)?.type === "makesafe");
          }
          // search_all_jobs reads a flat job_id list; myJobs reads the full
          // row with an embedded jobs relation — the real client shapes the
          // response differently for each, so the mock must too.
          if (st.select.replace(/\s+/g, "") === "id,job_id") {
            resolve({ data: rows.map((a) => ({ id: a.id, job_id: a.job_id })), error: null });
            return;
          }
          resolve({
            data: rows.map((a) => ({
              id: a.id,
              scheduled_date: a.scheduled_date,
              scheduled_end: null,
              start_time: null,
              status: a.status,
              role: "lead_installer",
              notes: null,
              assignment_type: "install",
              crew_name: null,
              started_at: null,
              completed_at: null,
              clocked_on_at: null,
              clocked_off_at: null,
              travel_started_at: null,
              arrived_at: null,
              break_minutes: null,
              job_phase: null,
              // A COPY, never the shared fixture object — production code
              // (presentTradeJobFeedRow's `delete job.org_id`, myJobs'
              // `delete a.jobs.pricing_json`, ...) mutates the row it is
              // handed, which must never corrupt JOBS for a later query in
              // the same test.
              jobs: (() => {
                const job = JOBS.find((j) => j.id === a.job_id);
                return job ? { ...job } : null;
              })(),
            })),
            error: null,
          });
          return;
        }
        if (table === "jobs") {
          let rows = JOBS.filter((j) => j.org_id === st.eq.org_id);
          if (st.inCol === "id" && st.inVals) {
            rows = rows.filter((j) => st.inVals!.includes(j.id));
          }
          if (st.orStr) {
            const excludeStatuses = new Set(
              (st.orStr.match(/type\.eq\.(\w+)/g) || []).map((m) => m.split(".")[2]),
            );
            if (excludeStatuses.size > 0) {
              rows = rows.filter((j) => excludeStatuses.has(j.type));
            }
          }
          resolve({ data: rows.map((j) => ({ ...j })), error: null });
          return;
        }
        resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

function tradeAuth(overrides: Partial<TradeAuthContext>): TradeAuthContext {
  return {
    id: CREW_ID,
    email: "crew@example.test",
    orgId: ORG_A,
    role: "crew",
    managedVerticals: [],
    seeEverything: false,
    ...overrides,
  };
}

Deno.test("rule table (end-to-end): ordinary crew's search_all_jobs is restricted server-side to their own assignments, never a company browse", async () => {
  const log: QueryLog = [];
  const res = await searchAllJobs(
    surfaceClient(log),
    new URLSearchParams(),
    tradeAuth({}),
    ORDINARY_CREW.isDispatcher,
  );
  const ids = res.jobs.map((j: any) => j.id).sort();
  assertEquals(ids, [JOB_FENCING, JOB_PATIO], "only their own allocations — never job-decking-1 or job-makesafe-1");
  const jobsQuery = log.find((q) => q.table === "jobs");
  assertEquals(jobsQuery?.inVals?.slice().sort(), [JOB_FENCING, JOB_PATIO], "the DB query itself is restricted, not just a client-side filter");
});

Deno.test("rule table (end-to-end): ordinary crew's search_all_jobs stays restricted even when typing a query — no client 2-character minimum relied on", async () => {
  const log: QueryLog = [];
  const res = await searchAllJobs(
    surfaceClient(log),
    new URLSearchParams("q=s"),
    tradeAuth({}),
    ORDINARY_CREW.isDispatcher,
  );
  const ids = res.jobs.map((j: any) => j.id).sort();
  // A single-character query would defeat any CLIENT-side length gate; the
  // server-side assignment restriction must hold regardless.
  assertEquals(
    ids.every((id: string) => id === JOB_FENCING || id === JOB_PATIO),
    true,
    "a 1-character query never surfaces a job outside their own allocations",
  );
});

// NOTE on scope: the personal ("mine") my_jobs lane keeps its own,
// separately-ruled 30-day-ish recency window (Captain 2026-08-17,
// _myJobsPersonalRecencyFilter) — this PR's item 3 named only "category-wide
// views" (mode:'all' for a category manager) for the full-history change, so
// the personal lane's window is deliberately left as is. search_all_jobs has
// no such window (item 4 is explicit: "past and present... including
// search"), so the two surfaces can legitimately differ on a very old
// personal allocation. If the Captain intends the personal lane to also go
// full-range, that is a follow-up, not silently folded into this change.
Deno.test("rule table (end-to-end): my_jobs for ordinary crew carries the present allocation; search (unlike the personal my_jobs window) also carries the far-past one", async () => {
  const g = await myJobs(
    surfaceClient([]),
    CREW_ID,
    false,
    ORDINARY_CREW.isDispatcher,
    ORDINARY_CREW.isMakesafeManager,
    ORDINARY_CREW.poolVerticals,
    [],
    ORG_A,
  );
  const seen = [
    ...g.today,
    ...g.thisWeek,
    ...g.upcoming,
    ...g.recent,
    ...(g.recentCompleted || []),
    ...(g.unscheduled || []),
  ].map((a: any) => a.jobs?.id);
  assertEquals(seen.includes(JOB_PATIO), true, "the present allocation is on the personal board");
  assertEquals(
    seen.includes(JOB_FENCING),
    false,
    "the 300-day-old allocation is outside the personal lane's own recency window (out of this ruling's scope)",
  );

  // The SAME far-past allocation IS visible on search — the surface item 4
  // named explicitly, and where this ruling closed a real leak.
  const searchRes = await searchAllJobs(
    surfaceClient([]),
    new URLSearchParams(),
    tradeAuth({}),
    ORDINARY_CREW.isDispatcher,
  );
  const searchIds = searchRes.jobs.map((j: any) => j.id);
  assertEquals(searchIds.includes(JOB_FENCING), true, "search carries the far-past allocation");
});

Deno.test("rule table: a ghost watcher row never grants the allocated tier", async () => {
  const d = await resolveTradeJobAccessTier(accessClient(), JOB_MAKESAFE, GHOST_ONLY_ID, {
    isOffice: false,
    access: ACCESS_NONE,
  });
  assertEquals(d.tier, "none", "an auto-mirrored ghost is a calendar mirror, not an allocation");
});

Deno.test("rule table (end-to-end): a ghost-only user's search_all_jobs is empty and never queries jobs", async () => {
  const log: QueryLog = [];
  const res = await searchAllJobs(
    surfaceClient(log),
    new URLSearchParams(),
    tradeAuth({ id: GHOST_ONLY_ID, role: "ops_manager" }),
    false,
  );
  assertEquals(res.jobs, []);
  assertEquals(res.total, 0);
  assertEquals(log.some((q) => q.table === "jobs"), false);
});

function manyAllocationsClient(jobCount: number, inSizes: number[]): any {
  const jobs = Array.from({ length: jobCount }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    org_id: ORG_A,
    type: "fencing",
    job_number: `SWF-${i}`,
    status: "complete",
    created_at: new Date(Date.UTC(2025, 0, 1) + i * 86400_000).toISOString(),
  }));
  const assignments = [
    ...jobs.map((j, i) => ({ id: `a-${String(i).padStart(4, "0")}`, job_id: j.id, user_id: CREW_ID, is_ghost: false })),
    ...jobs.map((j, i) => ({ id: `g-${String(i).padStart(4, "0")}`, job_id: j.id, user_id: CREW_ID, is_ghost: true })),
  ];
  function builder(table: string) {
    const eq: Record<string, unknown> = {};
    let inVals: string[] | null = null;
    let range: [number, number] | null = null;
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => { eq[k] = v; return b; },
      neq: () => b,
      not: () => b,
      or: () => b,
      order: () => b,
      in: (_k: string, vals: string[]) => { inVals = vals; inSizes.push(vals.length); return b; },
      range: (from: number, to: number) => { range = [from, to]; return b; },
      then: (resolve: any) => {
        if (table === "job_assignments") {
          let rows = assignments.filter((a) => a.user_id === eq.user_id && a.is_ghost === eq.is_ghost);
          if (range) rows = rows.slice(range[0], range[1] + 1);
          resolve({ data: rows, error: null });
          return;
        }
        if (table === "jobs") {
          const rows = jobs.filter((j) => j.org_id === eq.org_id && (!inVals || inVals.includes(j.id)));
          resolve({ data: rows.map((j) => ({ ...j })), error: null });
          return;
        }
        resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

Deno.test("rule table (end-to-end): an allocated-only history of 60 jobs is read in 25-id chunks and paged honestly", async () => {
  const inSizes: number[] = [];
  const client = manyAllocationsClient(60, inSizes);
  const first = await searchAllJobs(client, new URLSearchParams("page_size=50"), tradeAuth({}), false);
  assertEquals(first.total, 60);
  assertEquals(first.jobs.length, 50);
  assertEquals(first.next_offset, 50);
  assertEquals(first.truncated, true);
  assertEquals(first.jobs[0].job_number, "SWF-59", "newest first across chunk boundaries");
  assertEquals(inSizes.length > 0 && inSizes.every((n) => n <= 25), true, "no id filter exceeds 25 ids");

  const second = await searchAllJobs(client, new URLSearchParams("page_size=50&offset=50"), tradeAuth({}), false);
  assertEquals(second.jobs.length, 10);
  assertEquals(second.next_offset, null);
  assertEquals(second.truncated, false);
  const allIds = new Set([...first.jobs, ...second.jobs].map((j: any) => j.id));
  assertEquals(allIds.size, 60, "every allocated job appears exactly once");
});

function categoryManagerClient(): any {
  const jobs = [
    { id: "cm-fence-1", org_id: ORG_A, type: "fencing", job_number: "SWF-10", client_name: "Alpha", status: "scheduled", created_at: "2026-09-01T00:00:00Z" },
    { id: "cm-fence-2", org_id: ORG_A, type: "fencing", job_number: "SWF-11", client_name: "Bravo", status: "complete", created_at: "2026-08-01T00:00:00Z" },
    { id: "cm-patio-own", org_id: ORG_A, type: "patio", job_number: "SWP-20", client_name: "Alpha", status: "complete", created_at: "2026-07-01T00:00:00Z" },
    { id: "cm-patio-deleted", org_id: ORG_A, type: "patio", job_number: "SWP-21", client_name: "Alpha", status: "deleted", created_at: "2026-06-01T00:00:00Z" },
    { id: "cm-patio-other", org_id: ORG_A, type: "patio", job_number: "SWP-22", client_name: "Alpha", status: "scheduled", created_at: "2026-05-01T00:00:00Z" },
  ];
  const assignments = [
    { id: "cma-1", job_id: "cm-patio-own", user_id: "u-cm", is_ghost: false },
    { id: "cma-2", job_id: "cm-patio-deleted", user_id: "u-cm", is_ghost: false },
  ];
  function builder(table: string) {
    const eq: Record<string, unknown> = {};
    let inVals: string[] | null = null;
    let notIn: string[] = [];
    const ors: string[] = [];
    let range: [number, number] | null = null;
    let head = false;
    const b: any = {
      select: (_s: string, opts?: { head?: boolean }) => { head = !!opts?.head; return b; },
      eq: (k: string, v: unknown) => { eq[k] = v; return b; },
      neq: () => b,
      not: (k: string, op: string, v: string) => {
        if (k === "status" && op === "in") notIn = [...v.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        return b;
      },
      or: (s: string) => { ors.push(s); return b; },
      order: () => b,
      in: (_k: string, vals: string[]) => { inVals = vals; return b; },
      range: (from: number, to: number) => { range = [from, to]; return b; },
      then: (resolve: any) => {
        if (table === "job_assignments") {
          resolve({ data: assignments.filter((a) => a.user_id === eq.user_id && a.is_ghost === eq.is_ghost), error: null });
          return;
        }
        if (table === "jobs") {
          let rows = jobs.filter((j) => j.org_id === eq.org_id && !notIn.includes(j.status));
          if (inVals) rows = rows.filter((j) => inVals!.includes(j.id));
          for (const o of ors) {
            const types = [...o.matchAll(/type\.eq\.(\w+)/g)].map((m) => m[1]);
            const text = o.match(/client_name\.ilike\.%([^%]+)%/)?.[1];
            if (types.length) rows = rows.filter((j) => types.includes(j.type));
            if (text) rows = rows.filter((j) => j.client_name.toLowerCase().includes(text) || j.job_number.toLowerCase().includes(text));
          }
          rows.sort((a, c) => c.created_at.localeCompare(a.created_at));
          if (head) { resolve({ data: null, count: rows.length, error: null }); return; }
          if (range) rows = rows.slice(range[0], range[1] + 1);
          resolve({ data: rows.map((j) => ({ ...j })), error: null });
          return;
        }
        resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

const FENCING_CATEGORY_MANAGER = tradeAuth({ id: "u-cm", role: "ops_manager", managedVerticals: ["fencing"] });

Deno.test("rule table (end-to-end): a category manager's own out-of-vertical allocation joins page one only, never a deleted job", async () => {
  const client = categoryManagerClient();
  const first = await searchAllJobs(client, new URLSearchParams("page_size=1"), FENCING_CATEGORY_MANAGER, false);
  assertEquals(first.jobs.map((j: any) => j.id).sort(), ["cm-fence-1", "cm-patio-own"]);
  assertEquals(first.total, 3);
  assertEquals(first.next_offset, 1);

  const second = await searchAllJobs(client, new URLSearchParams("page_size=1&offset=1"), FENCING_CATEGORY_MANAGER, false);
  assertEquals(second.jobs.map((j: any) => j.id), ["cm-fence-2"], "the seed is not re-merged into later pages");
  assertEquals(second.total, 3);
  assertEquals(second.next_offset, null);
});

Deno.test("rule table (end-to-end): a category manager's typed search reaches their own out-of-vertical allocation, never a deleted or unallocated one", async () => {
  const res = await searchAllJobs(categoryManagerClient(), new URLSearchParams("q=alpha"), FENCING_CATEGORY_MANAGER, false);
  assertEquals(res.jobs.map((j: any) => j.id).sort(), ["cm-fence-1", "cm-patio-own"]);
});
