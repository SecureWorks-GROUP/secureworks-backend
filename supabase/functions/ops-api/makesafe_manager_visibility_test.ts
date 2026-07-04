import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _canSeeFullMakesafePool,
  _makesafePoolExcludedStatusFilter,
  _MAKESAFE_POOL_EXCLUDED_STATUSES,
  _resolveMakesafeVisibility,
} from "./index.ts";

// Mirrors the route computation (ops-api trade route): showAll is dispatcher-only.
// A make-safe manager is NOT a dispatcher, so showAll must stay false for them.
function computeShowAll(isDispatcher: boolean, mode: string | null): boolean {
  return isDispatcher && mode !== "mine";
}

Deno.test("flagged make-safe manager (not dispatcher) can see the full make-safe pool", () => {
  // Hugo = lead_installer, Nithin = sales; role is irrelevant once the flag is set.
  const hugo = _resolveMakesafeVisibility({ role: "lead_installer", makesafeManager: true });
  assertEquals(hugo.isDispatcher, false);
  assertEquals(hugo.isMakesafeManager, true);
  assertEquals(hugo.canSeeMakesafePool, true);

  const nithin = _resolveMakesafeVisibility({ role: "sales", makesafeManager: true });
  assertEquals(nithin.isDispatcher, false);
  assertEquals(nithin.canSeeMakesafePool, true);
});

Deno.test("normal trade user (no flag, not dispatcher) cannot see the make-safe pool", () => {
  const v = _resolveMakesafeVisibility({ role: "trade", makesafeManager: false });
  assertEquals(v.isAdmin, false);
  assertEquals(v.isDispatcher, false);
  assertEquals(v.isMakesafeManager, false);
  assertEquals(v.canSeeMakesafePool, false);
});

Deno.test("dispatcher (admin or ops_manager) still sees the pool unchanged", () => {
  const admin = _resolveMakesafeVisibility({ role: "admin", makesafeManager: false });
  assertEquals(admin.isAdmin, true);
  assertEquals(admin.isDispatcher, true);
  assertEquals(admin.canSeeMakesafePool, true);

  const opsManager = _resolveMakesafeVisibility({ role: "ops_manager", makesafeManager: false });
  assertEquals(opsManager.isAdmin, false);
  assertEquals(opsManager.isDispatcher, true);
  assertEquals(opsManager.canSeeMakesafePool, true);
});

Deno.test("union semantics: a non-dispatcher manager gets the pool WITHOUT showAll", () => {
  const manager = _resolveMakesafeVisibility({ role: "lead_installer", makesafeManager: true });
  // showAll drives the see-all all-users assignment query; a manager must NOT get
  // it, so their per-user assignment query still runs and is unioned with the pool.
  assertEquals(computeShowAll(manager.isDispatcher, null), false);
  assertEquals(computeShowAll(manager.isDispatcher, "all"), false);
  // The pool gate still opens for them.
  assertEquals(_canSeeFullMakesafePool(manager.isDispatcher, manager.isMakesafeManager), true);

  // A dispatcher DOES get showAll (unless mode=mine), and also the pool.
  const dispatcher = _resolveMakesafeVisibility({ role: "admin", makesafeManager: false });
  assertEquals(computeShowAll(dispatcher.isDispatcher, "all"), true);
  assertEquals(computeShowAll(dispatcher.isDispatcher, "mine"), false);
});

Deno.test("_canSeeFullMakesafePool opens for dispatcher OR manager, closed otherwise", () => {
  assertEquals(_canSeeFullMakesafePool(true, false), true); // dispatcher
  assertEquals(_canSeeFullMakesafePool(false, true), true); // manager
  assertEquals(_canSeeFullMakesafePool(true, true), true); // both
  assertEquals(_canSeeFullMakesafePool(false, false), false); // ordinary trade
});

Deno.test("make-safe pool exclusion list still excludes archived (and complete/invoiced states)", () => {
  assertEquals(_MAKESAFE_POOL_EXCLUDED_STATUSES.includes("archived"), true);
  for (const s of ["cancelled", "archived", "lost", "deleted", "complete", "completed", "invoiced", "paid", "closed", "duplicate", "duplicated", "void", "voided"]) {
    assertEquals(_MAKESAFE_POOL_EXCLUDED_STATUSES.includes(s as any), true, `expected ${s} to be excluded`);
  }
});

Deno.test("_makesafePoolExcludedStatusFilter renders the exact PostgREST not-in filter", () => {
  assertEquals(
    _makesafePoolExcludedStatusFilter(),
    '("cancelled","archived","lost","deleted","complete","completed","invoiced","paid","closed","duplicate","duplicated","void","voided")',
  );
});

Deno.test("_resolveMakesafeVisibility handles null/undefined role and flag safely", () => {
  const v = _resolveMakesafeVisibility({ role: null, makesafeManager: null });
  assertEquals(v.isAdmin, false);
  assertEquals(v.isDispatcher, false);
  assertEquals(v.isMakesafeManager, false);
  assertEquals(v.canSeeMakesafePool, false);

  // Only strict boolean true flips the flag (guards truthy non-boolean values).
  assertEquals(_resolveMakesafeVisibility({ makesafeManager: 1 as any }).isMakesafeManager, false);
  assertEquals(_resolveMakesafeVisibility({ makesafeManager: "true" as any }).isMakesafeManager, false);
});
