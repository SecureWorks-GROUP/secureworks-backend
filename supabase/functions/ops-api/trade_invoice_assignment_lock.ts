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

// ── Work Order / Commission job lines lock the trade's job cards ────────────
//
// Production gap (2026-09-11, trade "Alyx", invoice SW-INV-A-260830-025, week
// 2026-08-24..30, PAID in Xero): the first line billed SWF-261063 as a Work
// Order ("Work order $1477.00. Less labour: ..."). Layer B only stamped the
// assignment ids carried by LABOUR lines, so the lead_installer card on
// SWF-261063 kept invoiced_in NULL. my_hours kept showing it under the paid
// week, prefilled from the work order subtotal: a second bill for the same job
// was one tap away.
//
// A Work Order or Commission line bills the job, not hours, so it carries no
// assignment ids. These helpers decide which of the submitting trade's own
// job cards that line consumes, so the same Layer B stamp can lock them.

/** Line types the trade app writes for job-level (non-hours) lines. */
export const WORK_ORDER_LOCK_LINE_TYPES: readonly string[] = [
  "work order", // trade app: type 'Work Order', lower-cased by the submit path
  "work_order",
  "commission", // trade app: type 'Commission'
];

/** Negative weekly lines move money between crews; they never bill a job card. */
const WEEKLY_DEDUCTION_LINE_TYPES: ReadonlySet<string> = new Set([
  "crew_work_order_deduction",
  "labour_deduction",
  "travel_logistics_deduction",
  "materials_deduction",
  "final_payout_deduction",
]);

export interface WorkOrderLockLine {
  job_id?: string | null;
  job_number?: string | null;
  line_type?: string | null;
  source_work_order_id?: string | null;
}

/**
 * True when an invoice line bills a whole job for the submitting trade:
 * a Work Order or Commission line with a job, or a positive weekly
 * work-order scope line (server-resolved from a work order).
 */
export function isWorkOrderLockLine(line: WorkOrderLockLine): boolean {
  if (!line?.job_id) return false;
  const lineType = String(line.line_type || "").trim().toLowerCase();
  if (WORK_ORDER_LOCK_LINE_TYPES.includes(lineType)) return true;
  return Boolean(line.source_work_order_id) &&
    !WEEKLY_DEDUCTION_LINE_TYPES.has(lineType);
}

/** Distinct job ids billed by Work Order / Commission lines, with a label each. */
export function workOrderLockJobs(
  lines: readonly WorkOrderLockLine[],
): { jobIds: string[]; jobLabelByJobId: Record<string, string> } {
  const jobLabelByJobId: Record<string, string> = {};
  const jobIds: string[] = [];
  for (const line of lines || []) {
    if (!isWorkOrderLockLine(line)) continue;
    const jobId = String(line.job_id);
    if (!jobIds.includes(jobId)) jobIds.push(jobId);
    if (line.job_number && !jobLabelByJobId[jobId]) {
      jobLabelByJobId[jobId] = String(line.job_number);
    }
  }
  return { jobIds, jobLabelByJobId };
}

export interface WorkOrderLockCandidate extends AssignmentLockRef {
  job_id: string;
  scheduled_date?: string | null;
}

/**
 * Pick the trade's own job cards a Work Order / Commission line consumes.
 * Candidates must already be scoped to the submitting trade and to the billed
 * jobs.
 *
 *  - Weekly invoice (weekStart and weekEnd set): every card on the job
 *    scheduled inside the week. A card already held by a LIVE invoice is still
 *    returned, so the Layer B lock plan refuses and names it instead of billing
 *    the job twice.
 *  - Non-week invoice: every card on the job that is not already on a live
 *    invoice and is not scheduled after `notAfter` (the submit date). A future
 *    card is work not yet done; locking it would hide real work from the trade.
 */
export function selectWorkOrderLineAssignmentIds(params: {
  candidates: readonly WorkOrderLockCandidate[];
  weekStart?: string | null;
  weekEnd?: string | null;
  liveInvoiceIds: ReadonlySet<string>;
  notAfter: string;
}): string[] {
  const { weekStart, weekEnd, liveInvoiceIds, notAfter } = params;
  const weekly = Boolean(weekStart && weekEnd);
  const ids: string[] = [];
  for (const c of params.candidates || []) {
    const date = c.scheduled_date ? String(c.scheduled_date).slice(0, 10) : null;
    if (weekly) {
      if (!date || date < String(weekStart) || date > String(weekEnd)) continue;
    } else {
      if (c.invoiced_in && liveInvoiceIds.has(String(c.invoiced_in))) continue;
      if (date && date > notAfter) continue;
    }
    const id = String(c.id);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
