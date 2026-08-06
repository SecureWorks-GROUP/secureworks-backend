/**
 * Trade-invoice assignment lock (Layer B) — pure helpers.
 *
 * Production failure (Trade App Pay tab, 2026-08-06, trade "Alyx", week
 * 2026-06-29):
 *   "Failed to lock invoiced job cards before Xero push:
 *    Only stamped 0 of 6 assignments"
 *
 * Three separate defects combined:
 *
 *  1. READ/WRITE ASYMMETRY. `my_hours` — the read that paints the Pay tab —
 *     hides assignments already held by a LIVE invoice. The submit handler's
 *     legacy *clocked* lane re-queried `job_assignments` server-side with only
 *     `user_id` + `status='complete'` and NO `invoiced_in` filter, so it
 *     silently re-added job cards the trade could not see and had not ticked.
 *     The manual lane always had this guard; the clocked lane never did.
 *
 *  2. NON-ATOMIC STAMP. The lock issued its UPDATE first and counted matched
 *     rows afterwards. A partial match mutated the rows it *did* match and then
 *     threw, so a recoverable "stamped 2 of 6" permanently consumed those 2 job
 *     cards and turned the next retry into an unrecoverable "stamped 0 of 6".
 *
 *  3. UNREACHABLE FAILURE STATUS. The failure handler wrote
 *     `trade_invoices.status = 'failed'`, which `trade_invoices_status_check`
 *     (migration 20260611000001) does not permit. PostgREST returned the error
 *     rather than throwing, the code ignored it, and the invoice stayed at
 *     `pending_acknowledgment` — a LIVE status — with no diagnostic note. Since
 *     LIVE invoices hold their assignments, every failed submission wedged its
 *     job cards forever.
 *
 * These helpers are pure so the decision logic can be tested without a
 * database. The eligibility decision is deliberately made BEFORE any write:
 * that is what makes the lock fail safely instead of half-claiming.
 *
 * Does NOT prove: that PostgREST applies the composed filters as expected, that
 * the Xero push succeeds, or that the surrounding handler wires these in. The
 * companion test pins the index.ts call sites for that last part; the first two
 * need a live read (out of scope for ops-api unit tests).
 */

/** Minimal shape the lock reasons about. */
export interface AssignmentLockRef {
  id: string;
  invoiced_in?: string | null;
}

/** Clocked-lane auto-fill shape (hours decide whether a row is billable). */
export interface ClockedAssignmentRef extends AssignmentLockRef {
  hours_worked?: number | null;
}

/**
 * Drop assignments held by a LIVE (non-released) invoice.
 *
 * Mirrors the `my_hours` read filter and the manual lane's ALREADY_INVOICED
 * guard. The clocked lane auto-fills rows the trade never selected, so a held
 * row is skipped silently rather than 409-ing: the trade cannot act on a job
 * card they were never shown.
 */
export function selectUnlockedAssignments<T extends AssignmentLockRef>(
  assignments: readonly T[],
  liveInvoiceIds: ReadonlySet<string>,
): T[] {
  return (assignments || []).filter(
    (a) => !(a.invoiced_in && liveInvoiceIds.has(String(a.invoiced_in))),
  );
}

/**
 * True when a clocked-lane row represents real billable time.
 *
 * The clocked lane exists to bill *clocked* work. A `status='complete'` card
 * with null/zero `hours_worked` was never clocked (all six of Alyx's rows were
 * exactly this). Auto-filling it produces a $0 line AND stamps `invoiced_in`,
 * permanently consuming a job card for nothing. Manual-hours submissions are
 * unaffected — they never reach this lane.
 */
export function isClockedAssignmentBillable(
  a: ClockedAssignmentRef,
): boolean {
  return Number(a?.hours_worked ?? 0) > 0;
}

export interface AssignmentLockPlan {
  /** Every expected assignment is claimable — safe to issue the UPDATE. */
  ok: boolean;
  /** Assignments free to claim (unstamped, or held by a released invoice). */
  claimableIds: string[];
  /** Assignments held by a live invoice, or missing from the candidate read. */
  blockedIds: string[];
  /** Expected ids with no matching candidate row. */
  missingIds: string[];
}

/**
 * Decide, BEFORE writing, whether all expected assignments can be claimed.
 *
 * An assignment is claimable when `invoiced_in` is null, or points at an
 * invoice in the released set (draft / ops-reject — see
 * RELEASED_INVOICE_STATUSES). A dangling `invoiced_in` (referenced invoice row
 * absent) is NOT claimable: it is unexplained state on the money path, so the
 * lock refuses rather than silently overwriting it.
 */
export function planAssignmentLock(params: {
  expectedIds: readonly string[];
  candidates: readonly AssignmentLockRef[];
  releasedInvoiceIds: readonly string[];
}): AssignmentLockPlan {
  const released = new Set((params.releasedInvoiceIds || []).map(String));
  const byId = new Map<string, AssignmentLockRef>();
  for (const c of params.candidates || []) byId.set(String(c.id), c);

  const claimableIds: string[] = [];
  const blockedIds: string[] = [];
  const missingIds: string[] = [];

  for (const rawId of params.expectedIds || []) {
    const id = String(rawId);
    const c = byId.get(id);
    if (!c) {
      missingIds.push(id);
      blockedIds.push(id);
      continue;
    }
    const held = c.invoiced_in ? String(c.invoiced_in) : null;
    if (!held || released.has(held)) claimableIds.push(id);
    else blockedIds.push(id);
  }

  return {
    ok: blockedIds.length === 0,
    claimableIds,
    blockedIds,
    missingIds,
  };
}

/**
 * Operator-facing reason a lock was refused.
 *
 * "Only stamped 0 of 6 assignments" told nobody which job cards were at fault.
 * Naming them is what turns this into a fixable ops ticket.
 */
export function describeAssignmentLockBlock(
  plan: AssignmentLockPlan,
  jobLabelById: Readonly<Record<string, string>> = {},
): string {
  const label = (id: string) => jobLabelById[id] || id;
  const parts: string[] = [];
  const alreadyHeld = plan.blockedIds.filter((id) =>
    !plan.missingIds.includes(id)
  );
  if (alreadyHeld.length > 0) {
    parts.push(
      alreadyHeld.length + " job card(s) already on a live invoice: " +
        alreadyHeld.map(label).join(", "),
    );
  }
  if (plan.missingIds.length > 0) {
    parts.push(
      plan.missingIds.length + " job card(s) not found: " +
        plan.missingIds.map(label).join(", "),
    );
  }
  return parts.join("; ") || "no claimable job cards";
}
