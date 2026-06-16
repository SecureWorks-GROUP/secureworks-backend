// M4 allocation truth — crew_assigned must derive from the LIVE assignments[],
// not the stale job_intelligence.assignment_count materialized-view column.
// See: coding/work/campaigns/makesafe-reporting-allocations-proof/evidence/
//      allocation-truth-proof-2026-06-16.md  (0/5 board-vs-backend matches, all
//      false because readiness read assignment_count instead of assignments[]).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _liveCrewAssignedForTest, _computeReadinessForTest } from "./index.ts";

// AWST-relative dates so the test holds regardless of when it runs.
const AWST_OFFSET_MS = 8 * 60 * 60 * 1000;
function awstDate(offsetDays: number): string {
  const d = new Date(Date.now() + AWST_OFFSET_MS);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const TODAY = awstDate(0);
const FUTURE = awstDate(7);
const PAST = awstDate(-10);

// ── liveCrewAssigned: the core derivation ──

Deno.test("liveCrewAssigned: true for a scheduled future assignment", () => {
  assertEquals(
    _liveCrewAssignedForTest([{ status: "scheduled", role: "lead_installer", scheduled_date: FUTURE }]),
    true,
  );
});

Deno.test("liveCrewAssigned: true for an assignment scheduled today", () => {
  assertEquals(
    _liveCrewAssignedForTest([{ status: "scheduled", role: "lead_installer", scheduled_date: TODAY }]),
    true,
  );
});

Deno.test("liveCrewAssigned: false when there are no assignments", () => {
  assertEquals(_liveCrewAssignedForTest([]), false);
  assertEquals(_liveCrewAssignedForTest(null), false);
  assertEquals(_liveCrewAssignedForTest(undefined), false);
});

Deno.test("liveCrewAssigned: false for a cancelled assignment", () => {
  assertEquals(
    _liveCrewAssignedForTest([{ status: "cancelled", role: "lead_installer", scheduled_date: FUTURE }]),
    false,
  );
});

Deno.test("liveCrewAssigned: false when the only assignment is a stale past date (SWMS-26604 case)", () => {
  // The proof's SWMS-26604: a scheduled (not cancelled) assignment dated in the
  // past. It must NOT count as crew-assigned — readiness should not flip ready.
  assertEquals(
    _liveCrewAssignedForTest([{ status: "scheduled", role: "lead_installer", scheduled_date: PAST }]),
    false,
  );
});

Deno.test("liveCrewAssigned: false for an observer/ghost-only assignment", () => {
  // The proof's 'Shaun ghost (observer)' — a pure observer is not real crew.
  assertEquals(
    _liveCrewAssignedForTest([{ status: "scheduled", role: "observer", scheduled_date: FUTURE }]),
    false,
  );
  assertEquals(
    _liveCrewAssignedForTest([{ status: "scheduled", assignment_type: "ghost", scheduled_date: FUTURE }]),
    false,
  );
});

Deno.test("liveCrewAssigned: true when a real lead is paired with an observer (SWMS-26632 case)", () => {
  // Jan + Nithin style pairing — at least one real installer present.
  assertEquals(
    _liveCrewAssignedForTest([
      { status: "scheduled", role: "observer", scheduled_date: FUTURE },
      { status: "scheduled", role: "lead_installer", scheduled_date: FUTURE },
    ]),
    true,
  );
});

Deno.test("liveCrewAssigned: ignores the synthetic open-pool card", () => {
  assertEquals(
    _liveCrewAssignedForTest([{ status: "available", role: "makesafe_open", assignment_type: "makesafe_open", scheduled_date: TODAY }]),
    false,
  );
});

Deno.test("liveCrewAssigned: tolerates calendar_events shape (assignment_status)", () => {
  // The scheduling path threads calendar_events rows, which use assignment_status.
  assertEquals(
    _liveCrewAssignedForTest([{ assignment_status: "scheduled", assignment_type: "install", scheduled_date: FUTURE }]),
    true,
  );
  assertEquals(
    _liveCrewAssignedForTest([{ assignment_status: "cancelled", assignment_type: "install", scheduled_date: FUTURE }]),
    false,
  );
});

// ── computeReadiness: the integration — the original defect ──

Deno.test("computeReadiness: make-safe crew_assigned is TRUE from live assignments even when assignment_count is 0", () => {
  // This is the exact bug: assignment_count (stale MV) = 0 but assignments[] has
  // a real future allocation. crew_assigned blocker must be MET.
  const readiness = _computeReadinessForTest(
    "makesafe",
    { assignment_count: 0 }, // stale job_intelligence row
    null,
    {},
    [{ status: "scheduled", role: "lead_installer", scheduled_date: FUTURE }],
  );
  const crew = readiness.blockers.find((b) => b.key === "crew_assigned");
  assertEquals(crew?.met, true);
});

Deno.test("computeReadiness: make-safe crew_assigned stays FALSE with only a stale past assignment", () => {
  // Adversarial: a stale-only assignment must NOT wrongly flip the job to ready.
  const readiness = _computeReadinessForTest(
    "makesafe",
    { assignment_count: 1 }, // even if the stale MV says 1
    null,
    {},
    [{ status: "scheduled", role: "lead_installer", scheduled_date: PAST }],
  );
  const crew = readiness.blockers.find((b) => b.key === "crew_assigned");
  assertEquals(crew?.met, false);
});

Deno.test("computeReadiness: falls back to assignment_count when no assignments[] threaded (non-allocation callers unchanged)", () => {
  const withCount = _computeReadinessForTest("patio", { assignment_count: 2 }, null, {});
  assertEquals(withCount.blockers.find((b) => b.key === "crew_assigned")?.met, true);
  const noCount = _computeReadinessForTest("patio", { assignment_count: 0 }, null, {});
  assertEquals(noCount.blockers.find((b) => b.key === "crew_assigned")?.met, false);
});
