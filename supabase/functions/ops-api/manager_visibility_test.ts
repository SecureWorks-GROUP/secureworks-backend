// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _groupTradeAssignmentsForTest,
  _jobVertical,
  _normalizeManagedVerticals,
  _resolveManagerVisibility,
} from "./index.ts";

// ── _normalizeManagedVerticals ─────────────────────────────────────────────
Deno.test("normalizeManagedVerticals: null / non-array / empty → []", () => {
  assertEquals(_normalizeManagedVerticals(null), []);
  assertEquals(_normalizeManagedVerticals(undefined), []);
  assertEquals(_normalizeManagedVerticals("makesafe" as unknown), []); // not an array
  assertEquals(_normalizeManagedVerticals([]), []);
});

Deno.test("normalizeManagedVerticals: lower-cases, trims, drops unknowns, de-dupes", () => {
  assertEquals(_normalizeManagedVerticals(["Fencing", " PATIO "]), ["fencing", "patio"]);
  assertEquals(_normalizeManagedVerticals(["makesafe", "makesafe"]), ["makesafe"]);
  assertEquals(_normalizeManagedVerticals(["fencing", "roofing", "welding"]), ["fencing"]);
  assertEquals(_normalizeManagedVerticals(["decking", 1 as unknown, null]), ["decking"]);
});

// ── _resolveManagerVisibility ──────────────────────────────────────────────
Deno.test("single managed vertical (fencing): pool = fencing only, not dispatcher", () => {
  const v = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["fencing"] });
  assertEquals(v.isAdmin, false);
  assertEquals(v.isDispatcher, false);
  assertEquals(v.isMakesafeManager, false);
  assertEquals(v.canSeeMakesafePool, false);
  assertEquals(v.managedVerticals, ["fencing"]);
  assertEquals(v.poolVerticals, ["fencing"]);
});

Deno.test("multi managed verticals: pool = union in canonical order", () => {
  const v = _resolveManagerVisibility({ role: "sales", managedVerticals: ["patio", "fencing"] });
  assertEquals(v.isDispatcher, false);
  // Canonical order is makesafe, fencing, patio, decking.
  assertEquals(v.poolVerticals, ["fencing", "patio"]);
});

Deno.test("no managed verticals + ordinary role: sees nothing", () => {
  const v = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: [] });
  assertEquals(v.isDispatcher, false);
  assertEquals(v.canSeeMakesafePool, false);
  assertEquals(v.poolVerticals, []);
});

Deno.test("legacy make-safe-only manager (managed=['makesafe']) preserves Hugo behaviour", () => {
  // Post-backfill Hugo: makesafe_manager=true -> managed_verticals=['makesafe'].
  const hugo = _resolveManagerVisibility({ role: "lead_installer", managedVerticals: ["makesafe"] });
  assertEquals(hugo.isDispatcher, false);
  assertEquals(hugo.isMakesafeManager, true);
  assertEquals(hugo.canSeeMakesafePool, true);
  assertEquals(hugo.poolVerticals, ["makesafe"]);
});

Deno.test("dispatcher (admin) keeps see-all + make-safe pool, no fencing/patio pool", () => {
  const admin = _resolveManagerVisibility({ role: "admin", managedVerticals: [] });
  assertEquals(admin.isAdmin, true);
  assertEquals(admin.isDispatcher, true);
  assertEquals(admin.canSeeMakesafePool, true);
  // Preserves the live behaviour: a dispatcher gets the make-safe pool ONLY
  // (fencing/patio open pools are opt-in via managed_verticals, not implicit).
  assertEquals(admin.poolVerticals, ["makesafe"]);
});

Deno.test("dispatcher (ops_manager) is a dispatcher and gets the make-safe pool", () => {
  const om = _resolveManagerVisibility({ role: "ops_manager", managedVerticals: [] });
  assertEquals(om.isAdmin, false);
  assertEquals(om.isDispatcher, true);
  assertEquals(om.canSeeMakesafePool, true);
  assertEquals(om.poolVerticals, ["makesafe"]);
});

Deno.test("manager of a non-makesafe vertical who ALSO manages makesafe gets both pools", () => {
  const v = _resolveManagerVisibility({ role: "sales", managedVerticals: ["patio", "makesafe"] });
  assertEquals(v.isMakesafeManager, true);
  assertEquals(v.canSeeMakesafePool, true);
  assertEquals(v.poolVerticals, ["makesafe", "patio"]);
});

Deno.test("resolveManagerVisibility handles null role + junk managedVerticals safely", () => {
  const v = _resolveManagerVisibility({ role: null, managedVerticals: "makesafe" as unknown });
  assertEquals(v.isDispatcher, false);
  assertEquals(v.managedVerticals, []);
  assertEquals(v.poolVerticals, []);
  assertEquals(v.canSeeMakesafePool, false);
});

// ── _jobVertical ───────────────────────────────────────────────────────────
Deno.test("jobVertical: plain jobs.type wins (lower-cased)", () => {
  assertEquals(_jobVertical({ type: "fencing" }), "fencing");
  assertEquals(_jobVertical({ type: "Patio" }), "patio");
  assertEquals(_jobVertical({ type: "decking" }), "decking");
});

Deno.test("jobVertical: make-safe detected by type OR SWMS- job_number", () => {
  assertEquals(_jobVertical({ type: "makesafe" }), "makesafe");
  // SWMS- prefix wins even when the legacy type isn't normalised yet.
  assertEquals(_jobVertical({ type: "general", job_number: "SWMS-26801" }), "makesafe");
});

Deno.test("jobVertical: null / empty job → empty string", () => {
  assertEquals(_jobVertical(null), "");
  assertEquals(_jobVertical({}), "");
});

// ── _groupTradeAssignmentsForTest: any *_open card → the pool lane ──────────
Deno.test("open-pool cards (makesafe + fencing + patio) all land in the pool lane, not Today", () => {
  const grouped = _groupTradeAssignmentsForTest([
    { id: "ms-open", scheduled_date: "2026-07-05", assignment_type: "makesafe_open", role: "makesafe_open" },
    { id: "fen-open", scheduled_date: "2026-07-05", assignment_type: "fencing_open", role: "fencing_open" },
    { id: "pat-open", scheduled_date: "2026-07-05", assignment_type: "patio_open", role: "patio_open" },
    { id: "today-job", scheduled_date: "2026-07-05", assignment_type: "install", role: "lead" },
    { id: "week-job", scheduled_date: "2026-07-08", assignment_type: "install", role: "lead" },
    { id: "upcoming-job", scheduled_date: "2026-07-14", assignment_type: "install", role: "lead" },
  ], "2026-07-05", "2026-07-11");

  assertEquals(grouped.makesafePool.map((a: { id: string }) => a.id), ["ms-open", "fen-open", "pat-open"]);
  assertEquals(grouped.today.map((a: { id: string }) => a.id), ["today-job"]);
  assertEquals(grouped.thisWeek.map((a: { id: string }) => a.id), ["week-job"]);
  assertEquals(grouped.upcoming.map((a: { id: string }) => a.id), ["upcoming-job"]);
});

Deno.test("Trade Today recent omits archived, finished, completed, and already-reported leftovers", () => {
  const grouped = _groupTradeAssignmentsForTest([
    { id: "archived-flag", scheduled_date: "2026-08-01", status: "scheduled", jobs: { id: "job-archived-flag", type: "fencing", status: "in_progress", archived: true } },
    { id: "finished-job", scheduled_date: "2026-08-02", status: "scheduled", jobs: { id: "job-finished", type: "fencing", status: "invoiced", archived: false } },
    { id: "completed-assignment", scheduled_date: "2026-08-03", status: "complete", jobs: { id: "job-completed-assignment", type: "fencing", status: "in_progress", archived: false } },
    { id: "reported-makesafe", scheduled_date: "2026-08-04", status: "complete", jobs: { id: "job-reported-makesafe", type: "makesafe", status: "accepted", archived: false } },
    { id: "report-in-makesafe", scheduled_date: "2026-08-05", status: "scheduled", jobs: { id: "job-report-in-makesafe", type: "makesafe", status: "accepted", archived: false } },
  ], "2026-08-14", "2026-08-16", {
    "job-reported-makesafe": {
      detail: { substatus: "waiting_on_trade_report", cycle_number: 1 },
      hasSubmittedReport: true,
    },
    "job-report-in-makesafe": {
      detail: { substatus: "admin_to_send_report", cycle_number: 1 },
      hasSubmittedReport: false,
    },
  });

  assertEquals(grouped.recent, []);
  // Completed allocations stay discoverable outside the Needs Report queue;
  // unfinished archived/terminal leftovers stay dropped (not "completed work").
  assertEquals(
    grouped.recentCompleted.map((a: { id: string }) => a.id),
    ["completed-assignment", "reported-makesafe"],
  );
});

Deno.test("Trade Today recent keeps a completed live make-safe while its current report is still owed", () => {
  const grouped = _groupTradeAssignmentsForTest([
    { id: "live-makesafe-needs-report", scheduled_date: "2026-08-13", status: "complete", jobs: { id: "job-live-makesafe", type: "makesafe", status: "accepted", archived: false } },
  ], "2026-08-14", "2026-08-16", {
    "job-live-makesafe": {
      detail: { substatus: "waiting_on_trade_report", cycle_number: 2 },
      hasSubmittedReport: false,
    },
  });

  assertEquals(grouped.recent.map((a: { id: string }) => a.id), ["live-makesafe-needs-report"]);
});

// A cancelled / lost / deleted / duplicated job is not "work I completed". The
// omit branch that feeds recentCompleted fires on those statuses BEFORE any
// completion reasoning, so without an explicit exclusion a complete assignment
// on a dead job is presented to the crew as finished work.
Deno.test("My recent completed excludes cancelled/lost/deleted/duplicate/void and archived jobs", () => {
  const grouped = _groupTradeAssignmentsForTest([
    { id: "on-cancelled", scheduled_date: "2026-08-01", status: "complete", jobs: { id: "j-cancelled", type: "fencing", status: "cancelled", archived: false } },
    { id: "on-lost", scheduled_date: "2026-08-01", status: "complete", jobs: { id: "j-lost", type: "fencing", status: "lost", archived: false } },
    { id: "on-deleted", scheduled_date: "2026-08-01", status: "complete", jobs: { id: "j-deleted", type: "fencing", status: "deleted", archived: false } },
    { id: "on-duplicate", scheduled_date: "2026-08-01", status: "complete", jobs: { id: "j-duplicate", type: "fencing", status: "duplicate", archived: false } },
    { id: "on-void", scheduled_date: "2026-08-01", status: "complete", jobs: { id: "j-void", type: "fencing", status: "voided", archived: false } },
    { id: "on-archived", scheduled_date: "2026-08-01", status: "complete", jobs: { id: "j-archived", type: "fencing", status: "in_progress", archived: true } },
    // The bucket's real subjects survive: a finished/invoiced job and a plain
    // complete allocation on a live job.
    { id: "on-invoiced", scheduled_date: "2026-08-02", status: "complete", jobs: { id: "j-invoiced", type: "fencing", status: "invoiced", archived: false } },
    { id: "on-live", scheduled_date: "2026-08-03", status: "complete", jobs: { id: "j-live", type: "fencing", status: "in_progress", archived: false } },
  ], "2026-08-14", "2026-08-16");

  assertEquals(grouped.recent, []);
  assertEquals(
    grouped.recentCompleted.map((a: { id: string }) => a.id),
    ["on-invoiced", "on-live"],
  );
});
