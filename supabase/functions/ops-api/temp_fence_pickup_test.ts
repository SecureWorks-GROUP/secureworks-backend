import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _deriveFenceHireState, FENCE_HIRE_STATUSES } from "./index.ts";

// Mission temp-fence-pickup-2026-06-16.
// Truth table for the timer-aware pickup derivation. "today" pinned to a fixed
// Perth-context instant so the boundary case is deterministic. 2026-06-16T12:00Z
// = 2026-06-16 20:00 Perth, so Perth date = 2026-06-16.
const NOW = "2026-06-16T12:00:00Z";

Deno.test("fence: NULL status = not a hire job", () => {
  const r = _deriveFenceHireState(null, null, NOW);
  assertEquals(r.fence_hire_state, null);
  assertEquals(r.needs_pickup, false);
  assertEquals(r.hire_overdue, false);
});

Deno.test("fence: out + future end date stays out", () => {
  const r = _deriveFenceHireState("out", "2026-09-16", NOW);
  assertEquals(r.fence_hire_state, "out");
  assertEquals(r.needs_pickup, false);
  assertEquals(r.hire_overdue, false);
});

Deno.test("fence: out + end date == today (Perth) flips to needs_pickup (inclusive boundary)", () => {
  const r = _deriveFenceHireState("out", "2026-06-16", NOW);
  assertEquals(r.fence_hire_state, "needs_pickup");
  assertEquals(r.needs_pickup, true);
  assertEquals(r.hire_overdue, true);
});

Deno.test("fence: out + past end date = needs_pickup overdue", () => {
  const r = _deriveFenceHireState("out", "2026-03-01", NOW);
  assertEquals(r.fence_hire_state, "needs_pickup");
  assertEquals(r.needs_pickup, true);
  assertEquals(r.hire_overdue, true);
});

Deno.test("fence: out + NULL end date never auto-flips (open-ended hire, no false dispatch)", () => {
  const r = _deriveFenceHireState("out", null, NOW);
  assertEquals(r.fence_hire_state, "out");
  assertEquals(r.needs_pickup, false);
  assertEquals(r.hire_overdue, false);
});

Deno.test("fence: out + unparseable end date stays out (defensive)", () => {
  const r = _deriveFenceHireState("out", "not-a-date", NOW);
  assertEquals(r.fence_hire_state, "out");
  assertEquals(r.needs_pickup, false);
});

Deno.test("fence: already-flagged needs_pickup stays needs_pickup regardless of date", () => {
  const r = _deriveFenceHireState("needs_pickup", "2026-12-31", NOW);
  assertEquals(r.fence_hire_state, "needs_pickup");
  assertEquals(r.needs_pickup, true);
});

Deno.test("fence: picked_up is terminal, never reverts even if date passed", () => {
  const r = _deriveFenceHireState("picked_up", "2026-01-01", NOW);
  assertEquals(r.fence_hire_state, "picked_up");
  assertEquals(r.needs_pickup, false);
  assertEquals(r.hire_overdue, false);
});

Deno.test("fence: end-date one day after today stays out (boundary is exclusive above)", () => {
  const r = _deriveFenceHireState("out", "2026-06-17", NOW);
  assertEquals(r.fence_hire_state, "out");
  assertEquals(r.needs_pickup, false);
});

Deno.test("fence: status set has exactly the three lifecycle values", () => {
  assertEquals([...FENCE_HIRE_STATUSES], ["out", "needs_pickup", "picked_up"]);
});
