/**
 * Regression: trade invoice submission dies on "Only stamped 0 of 6 assignments".
 *
 * Production failure (Trade App Pay tab, 2026-08-06, trade "Alyx",
 * week 2026-06-29, invoice ad245628-…):
 *   "Failed to lock invoiced job cards before Xero push:
 *    Only stamped 0 of 6 assignments"
 *
 * The live shapes reproduced below are read-only observations from that
 * incident, so the suite fails against the pre-fix logic and passes after:
 *
 *   • 6 job_assignments, user Alyx, week 2026-06-29, status='complete',
 *     hours_worked = NULL, clocked_on_at/off_at = NULL, is_ghost = false.
 *   • 4 held by invoice b4b91266 (status 'pushed_to_xero' — LIVE),
 *     2 held by invoice 04488d17 (status 'pending_acknowledgment' — LIVE).
 *   • The 2 held by 04488d17 were stamped by the EARLIER 02:56 attempt, which
 *     itself failed with "Only stamped 2 of 6" — a partial write that was never
 *     rolled back and is what wedged the 03:18 retry into "0 of 6".
 *   • The proven-working case, invoice b4b91266 (week 2026-06-29, pushed to
 *     Xero 2026-07-14), stamped 4 of 4 because those rows were still unheld.
 *
 * Does NOT prove: that PostgREST composes the resulting filters as expected,
 * that the Xero push succeeds, or that `trade_invoices_status_check` still
 * excludes 'failed'. Those need live reads (out of scope for unit tests).
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  describeAssignmentLockBlock,
  isClockedAssignmentBillable,
  planAssignmentLock,
  selectUnlockedAssignments,
} from "./trade_invoice_assignment_lock.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// ── Live shapes from the incident ───────────────────────────────────────────
const INV_PUSHED = "b4b91266-563d-42be-9d17-3d485a3c3bed"; // pushed_to_xero → LIVE
const INV_PENDING = "04488d17-1503-48ee-8583-c1ce95ab119a"; // pending_acknowledgment → LIVE
const _INV_NEW = "ad245628-7a6d-4b0a-a449-a99b3dfb7cdb"; // the 03:18 invoice, for reference

/** All six carry hours_worked = null: complete, but never clocked. */
const ALYX_SIX = [
  {
    id: "202d174a-a084-455a-9de9-10b45efe8bc1",
    job: "SWMS-26841",
    invoiced_in: INV_PUSHED,
    hours_worked: null,
  },
  {
    id: "92d7eeb0-f239-4bb9-989c-87d13ef75f6e",
    job: "SWMS-26835",
    invoiced_in: INV_PUSHED,
    hours_worked: null,
  },
  {
    id: "bf821a9a-7265-4a8a-9098-574165095813",
    job: "SWMS-26836",
    invoiced_in: INV_PUSHED,
    hours_worked: null,
  },
  {
    id: "fafa1293-af98-4e5b-bb79-e775d77cfd5f",
    job: "SWMS-26840",
    invoiced_in: INV_PUSHED,
    hours_worked: null,
  },
  {
    id: "027bb8f4-e359-4140-a103-b21f71a18d15",
    job: "SWF-26613",
    invoiced_in: INV_PENDING,
    hours_worked: null,
  },
  {
    id: "2d77301a-a21d-4c03-91aa-744a9344f524",
    job: "SWF-26609",
    invoiced_in: INV_PENDING,
    hours_worked: null,
  },
];

/** Both referencing invoices are LIVE — neither is draft/ops-reject. */
const LIVE_INVOICE_IDS = new Set([INV_PUSHED, INV_PENDING]);

const JOB_LABELS: Record<string, string> = Object.fromEntries(
  ALYX_SIX.map((a) => [a.id, a.job]),
);

// ── 1. Root cause: the clocked lane must not re-collect held job cards ──────

Deno.test("clocked lane drops all six live-invoiced job cards (was: collected all six)", () => {
  const kept = selectUnlockedAssignments(ALYX_SIX, LIVE_INVOICE_IDS);
  assertEquals(
    kept.length,
    0,
    "every one of Alyx's six cards is held by a LIVE invoice and must not be auto-filled",
  );
});

Deno.test("clocked lane keeps a card released by a draft/ops-reject invoice", () => {
  const released = "11111111-1111-1111-1111-111111111111";
  const rows = [
    { id: "a", invoiced_in: null, hours_worked: 4 },
    { id: "b", invoiced_in: released, hours_worked: 4 }, // released → reclaimable
    { id: "c", invoiced_in: INV_PUSHED, hours_worked: 4 }, // LIVE → held
  ];
  // `released` is absent from liveInvoiceIds, i.e. its invoice is draft/ops-reject.
  const kept = selectUnlockedAssignments(rows, LIVE_INVOICE_IDS);
  assertEquals(
    kept.map((r) => r.id),
    ["a", "b"],
    "must not over-exclude released cards",
  );
});

Deno.test("never-clocked cards are not auto-filled into a clocked invoice", () => {
  // A $0 line still stamps invoiced_in, permanently consuming the job card.
  for (const a of ALYX_SIX) {
    assert(
      !isClockedAssignmentBillable(a),
      `${a.job} has hours_worked=null and must not be auto-filled`,
    );
  }
  assert(isClockedAssignmentBillable({ id: "x", hours_worked: 4.5 }));
  assert(!isClockedAssignmentBillable({ id: "y", hours_worked: 0 }));
  assert(!isClockedAssignmentBillable({ id: "z" }));
});

// ── 2. The lock itself: decide before writing ──────────────────────────────

Deno.test("lock refuses BEFORE writing when every card is held (the 0-of-6 case)", () => {
  const plan = planAssignmentLock({
    expectedIds: ALYX_SIX.map((a) => a.id),
    candidates: ALYX_SIX,
    releasedInvoiceIds: [], // neither referencing invoice is released
  });
  assertEquals(plan.ok, false);
  assertEquals(plan.claimableIds.length, 0);
  assertEquals(plan.blockedIds.length, 6);
  assertEquals(
    plan.missingIds.length,
    0,
    "all six rows exist — this was never a missing-row bug",
  );
});

Deno.test("lock refuses BEFORE writing on a PARTIAL match (the 02:56 half-claim)", () => {
  // State at 02:56: 4 held by the pushed invoice, 2 still free. The old code
  // ran the UPDATE, claimed those 2, then threw — wedging them for good.
  const at0256 = ALYX_SIX.map((a) => ({
    ...a,
    invoiced_in: a.invoiced_in === INV_PENDING ? null : a.invoiced_in,
  }));
  const plan = planAssignmentLock({
    expectedIds: at0256.map((a) => a.id),
    candidates: at0256,
    releasedInvoiceIds: [],
  });
  assertEquals(
    plan.ok,
    false,
    "a partial claim must be refused, not half-applied",
  );
  assertEquals(plan.claimableIds.length, 2);
  assertEquals(plan.blockedIds.length, 4);
});

Deno.test("lock succeeds N-of-N for the proven-working case (b4b91266, 4 of 4)", () => {
  // Before 2026-07-14 those four rows were unheld; that submission pushed to Xero.
  const free = ALYX_SIX.filter((a) => a.invoiced_in === INV_PUSHED)
    .map((a) => ({ ...a, invoiced_in: null }));
  const plan = planAssignmentLock({
    expectedIds: free.map((a) => a.id),
    candidates: free,
    releasedInvoiceIds: [],
  });
  assertEquals(plan.ok, true);
  assertEquals(plan.claimableIds.length, 4);
  assertEquals(plan.blockedIds.length, 0);
});

Deno.test("lock reclaims cards held by a RELEASED invoice, and only those", () => {
  const releasedInv = "22222222-2222-2222-2222-222222222222";
  const rows = [
    { id: "a", invoiced_in: null },
    { id: "b", invoiced_in: releasedInv },
    { id: "c", invoiced_in: INV_PUSHED }, // live → still blocked
  ];
  const plan = planAssignmentLock({
    expectedIds: ["a", "b", "c"],
    candidates: rows,
    releasedInvoiceIds: [releasedInv],
  });
  assertEquals(plan.claimableIds, ["a", "b"]);
  assertEquals(
    plan.blockedIds,
    ["c"],
    "a released ref must not unlock a live-held card",
  );
  assertEquals(plan.ok, false);
});

Deno.test("a dangling invoiced_in is blocked, never silently overwritten", () => {
  // Referenced invoice row absent: not in releasedInvoiceIds, so not claimable.
  const plan = planAssignmentLock({
    expectedIds: ["a"],
    candidates: [{
      id: "a",
      invoiced_in: "33333333-3333-3333-3333-333333333333",
    }],
    releasedInvoiceIds: [],
  });
  assertEquals(plan.ok, false);
  assertEquals(plan.blockedIds, ["a"]);
});

Deno.test("a missing candidate row is reported as missing, not as claimable", () => {
  const plan = planAssignmentLock({
    expectedIds: ["a", "b"],
    candidates: [{ id: "a", invoiced_in: null }],
    releasedInvoiceIds: [],
  });
  assertEquals(plan.ok, false);
  assertEquals(plan.claimableIds, ["a"]);
  assertEquals(plan.missingIds, ["b"]);
});

// ── 3. The refusal message names the job cards ─────────────────────────────

Deno.test("refusal names the blocking job cards instead of '0 of 6'", () => {
  const plan = planAssignmentLock({
    expectedIds: ALYX_SIX.map((a) => a.id),
    candidates: ALYX_SIX,
    releasedInvoiceIds: [],
  });
  const msg = describeAssignmentLockBlock(plan, JOB_LABELS);
  assertStringIncludes(msg, "6 job card(s) already on a live invoice");
  for (const a of ALYX_SIX) assertStringIncludes(msg, a.job);
});

Deno.test("refusal distinguishes held cards from missing cards", () => {
  const plan = planAssignmentLock({
    expectedIds: ["held", "gone"],
    candidates: [{ id: "held", invoiced_in: INV_PUSHED }],
    releasedInvoiceIds: [],
  });
  const msg = describeAssignmentLockBlock(plan);
  assertStringIncludes(msg, "already on a live invoice: held");
  assertStringIncludes(msg, "not found: gone");
});

// ── 4. Call-site pins in index.ts ──────────────────────────────────────────

Deno.test("index.ts clocked lane filters live-invoiced and never-clocked rows", () => {
  assertStringIncludes(
    INDEX,
    "selectUnlockedAssignments(asn || [], clockedLiveRefIds)",
  );
  assertStringIncludes(INDEX, "isClockedAssignmentBillable(a)");
  // The lane cannot filter on a column it does not select.
  assertStringIncludes(
    INDEX,
    "manual_override_flag, scheduled_date, status, invoiced_in",
  );
});

Deno.test("index.ts decides the lock before issuing the stamp UPDATE", () => {
  const planAt = INDEX.indexOf("const lockPlan = planAssignmentLock({");
  const updateAt = INDEX.indexOf(
    "const stampQuery = client.from('job_assignments')",
  );
  assert(planAt > 0, "Layer B must build a lock plan");
  assert(updateAt > 0, "Layer B must still issue the stamp UPDATE");
  assert(
    planAt < updateAt,
    "eligibility must be decided BEFORE the UPDATE, or a partial claim persists",
  );
  assertStringIncludes(INDEX, "if (!lockPlan.ok) {");
});

Deno.test("index.ts treats the current invoice's own stamps as claimable", () => {
  // A failed rollback leaves invoiced_in = invoice.id while the invoice is
  // demoted to 'draft'. The retry reuses that draft and promotes it LIVE before
  // the stamp read, so without this the trade's own prior stamps read as
  // "already on a live invoice" — a permanent wedge for the week.
  assertStringIncludes(
    INDEX,
    "...new Set([...releasedStampInvoiceIds, String(invoice.id)])",
  );
  assertStringIncludes(INDEX, "releasedInvoiceIds: claimableStampInvoiceIds,");
  assertStringIncludes(
    INDEX,
    ".or('invoiced_in.is.null,invoiced_in.in.(' + claimableStampInvoiceIds.join(',') + ')')",
  );
});

Deno.test("index.ts rolls back a partial claim scoped to the rows it stamped", () => {
  // The weekly draft id predates the request, so `invoiced_in = invoice.id`
  // alone can match rows stamped by an earlier attempt or a concurrent winner.
  // The rollback must release only the ids the stamp UPDATE returned.
  assertStringIncludes(INDEX, ".update({ invoiced_in: null })");
  const rollbackAt = INDEX.indexOf(".update({ invoiced_in: null })");
  const rollback = INDEX.slice(rollbackAt, rollbackAt + 200);
  assertStringIncludes(rollback, ".eq('invoiced_in', invoice.id)");
  assertStringIncludes(rollback, ".in('id', stampedIdList)");
});

Deno.test("index.ts never writes the CHECK-illegal 'failed' status to trade_invoices", () => {
  // `trade_invoices_status_check` (20260611000001) permits: draft,
  // pending_acknowledgment, queried, acknowledged, pending_ops_review,
  // approved, pushed_to_xero, paid, ops-reject. Writing 'failed' is silently
  // rejected by PostgREST and leaves the invoice LIVE, holding its assignments.
  const offenders = [
    ...INDEX.matchAll(
      /from\('trade_invoices'\)\s*\.update\(\{[^}]*status:\s*'failed'/g,
    ),
  ];
  assertEquals(
    offenders.length,
    0,
    `trade_invoices.status = 'failed' violates trade_invoices_status_check: ${
      offenders.map((m) => m[0]).join(" | ")
    }`,
  );
});

Deno.test("the stamp-failure handler releases the invoice for retry", () => {
  assertStringIncludes(
    INDEX,
    "query_note: ('Invoice assignment stamp failed before Xero push: '",
  );
  // Released status → the next submission for the week re-uses this row.
  const failHandlerAt = INDEX.indexOf(
    "const failAssignmentStamp = async (stampMsg: string) => {",
  );
  assert(failHandlerAt > 0);
  const handler = INDEX.slice(failHandlerAt, failHandlerAt + 700);
  assertStringIncludes(handler, "status: 'draft'");
});
