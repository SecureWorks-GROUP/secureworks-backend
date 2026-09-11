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

/**
 * Weekly work-order scope line types that bill the job's own work.
 *
 * `weeklyScopeLineType` (trade_invoice_weekly.ts) classifies every server-
 * resolved work-order scope line as one of: travel, materials, patio, labour,
 * other. Only 'labour' and 'patio' bill the crew's work on the job; a travel or
 * materials line reimburses a cost and must never consume a lead installer's
 * day card. Listed explicitly, not by excluding deduction types: the five
 * deduction types are excluded automatically by not being on this list, and a
 * future scope line type is excluded until someone decides it bills the job.
 */
export const WEEKLY_WORK_ORDER_SCOPE_LOCK_LINE_TYPES: readonly string[] = [
  "labour",
  "patio",
];

export interface WorkOrderLockLine {
  job_id?: string | null;
  job_number?: string | null;
  line_type?: string | null;
  line_date?: string | null;
  source_work_order_id?: string | null;
}

/**
 * True when an invoice line bills a whole job for the submitting trade:
 * a Work Order or Commission line with a job, or a weekly work-order scope
 * line (server-resolved from a work order) whose type bills the job's work.
 */
export function isWorkOrderLockLine(line: WorkOrderLockLine): boolean {
  if (!line?.job_id) return false;
  const lineType = String(line.line_type || "").trim().toLowerCase();
  if (WORK_ORDER_LOCK_LINE_TYPES.includes(lineType)) return true;
  return Boolean(line.source_work_order_id) &&
    WEEKLY_WORK_ORDER_SCOPE_LOCK_LINE_TYPES.includes(lineType);
}

/** Inclusive date window a non-week invoice bills on one job. */
export interface WorkOrderLockWindow {
  from: string;
  to: string;
}

/**
 * Distinct job ids billed by Work Order / Commission lines, with a label and a
 * billed date window each.
 *
 * The window is the min and max `line_date` across that job's OWN job-level
 * billing lines on this invoice. It is what bounds a non-week invoice's lock:
 * without it a $200 commission line silently swallowed every unbilled day card
 * the trade ever had on that job. A job whose billing lines carry no usable
 * `line_date` gets no window, and therefore locks nothing.
 */
export function workOrderLockJobs(
  lines: readonly WorkOrderLockLine[],
): {
  jobIds: string[];
  jobLabelByJobId: Record<string, string>;
  jobWindowByJobId: Record<string, WorkOrderLockWindow>;
} {
  const jobLabelByJobId: Record<string, string> = {};
  const jobWindowByJobId: Record<string, WorkOrderLockWindow> = {};
  const jobIds: string[] = [];
  for (const line of lines || []) {
    if (!isWorkOrderLockLine(line)) continue;
    const jobId = String(line.job_id);
    if (!jobIds.includes(jobId)) jobIds.push(jobId);
    if (line.job_number && !jobLabelByJobId[jobId]) {
      jobLabelByJobId[jobId] = String(line.job_number);
    }
    const date = normalizedLockDate(line.line_date);
    if (!date) continue;
    const window = jobWindowByJobId[jobId];
    if (!window) {
      jobWindowByJobId[jobId] = { from: date, to: date };
      continue;
    }
    if (date < window.from) window.from = date;
    if (date > window.to) window.to = date;
  }
  return { jobIds, jobLabelByJobId, jobWindowByJobId };
}

/** `YYYY-MM-DD`, or null when the value is absent or not a calendar date. */
function normalizedLockDate(value: unknown): string | null {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/** A billed job whose job-level lines carry no usable line_date. */
export interface WorkOrderLockJobWithoutWindow {
  jobId: string;
  jobNumber: string | null;
  lineTypes: string[];
}

/**
 * Billed jobs that get NO date window, and the line types that billed them.
 *
 * A non-week invoice can only lock inside the window its own job-level lines
 * bill, so a Work Order or Commission line with no `line_date` locks nothing.
 * That is the deliberate safe choice — guessing a range is what over-locked a
 * trade's unbilled day cards — but it is silent, and silence on the money path
 * is how the original double-bill survived. This is what the submit path
 * reports so ops can see the line went through without locking its job.
 *
 * Weekly invoices are unaffected: their window is the invoice week.
 */
export function workOrderLockJobsWithoutWindow(
  lines: readonly WorkOrderLockLine[],
): WorkOrderLockJobWithoutWindow[] {
  const { jobIds, jobLabelByJobId, jobWindowByJobId } = workOrderLockJobs(lines);
  const lineTypesByJobId: Record<string, string[]> = {};
  for (const line of lines || []) {
    if (!isWorkOrderLockLine(line)) continue;
    const jobId = String(line.job_id);
    if (jobWindowByJobId[jobId]) continue;
    const lineType = String(line.line_type || "").trim().toLowerCase() ||
      "(none)";
    const seen = lineTypesByJobId[jobId] || (lineTypesByJobId[jobId] = []);
    if (!seen.includes(lineType)) seen.push(lineType);
  }
  return jobIds
    .filter((jobId) => !jobWindowByJobId[jobId])
    .map((jobId) => ({
      jobId,
      jobNumber: jobLabelByJobId[jobId] || null,
      lineTypes: lineTypesByJobId[jobId] || [],
    }));
}

/** Operator-facing note for billed jobs that locked nothing for want of a date. */
export function describeWorkOrderLinesWithoutWindow(
  entries: readonly WorkOrderLockJobWithoutWindow[],
): string {
  const rows = entries || [];
  if (rows.length === 0) return "";
  const described = rows.map((entry) => {
    const lineTypes = entry.lineTypes.length > 0
      ? " (" + entry.lineTypes.join(", ") + ")"
      : "";
    return (entry.jobNumber || entry.jobId) + lineTypes;
  });
  return rows.length +
    " job(s) billed with no line date, so no job cards were locked for them: " +
    described.join(", ");
}

export interface WorkOrderLockCandidate extends AssignmentLockRef {
  job_id: string;
  scheduled_date?: string | null;
}

export interface WorkOrderLineAssignmentSelection {
  /** Cards this invoice's job-level lines consume and may stamp. */
  assignmentIds: string[];
  /**
   * In-scope cards a DIFFERENT live invoice already holds. Left out of the
   * stamp set and reported on the invoice instead of failing the submit.
   */
  alreadyHeldIds: string[];
}

/**
 * Pick the trade's own job cards a Work Order / Commission line consumes.
 * Candidates must already be scoped to the submitting trade and to the billed
 * jobs.
 *
 *  - Weekly invoice (weekStart and weekEnd set): every card on the job
 *    scheduled inside the week.
 *  - Non-week invoice: every card on the job scheduled inside the window this
 *    invoice's own job-level lines bill (`jobWindows`, from their line_date),
 *    clamped at `notAfter` (the submit date) because a card scheduled later is
 *    work not yet done. A job with no derivable window locks NOTHING rather
 *    than guessing a range, and an undated card is never locked because it
 *    cannot be shown to fall inside the window.
 *
 * A card already held by a different LIVE invoice is never stamped and is
 * returned separately: it is already billed, and blocking the trade's whole
 * week over it is worse than noting it on the invoice.
 */
export function selectWorkOrderLineAssignmentIds(params: {
  candidates: readonly WorkOrderLockCandidate[];
  weekStart?: string | null;
  weekEnd?: string | null;
  liveInvoiceIds: ReadonlySet<string>;
  notAfter: string;
  jobWindows?: Readonly<Record<string, WorkOrderLockWindow>>;
}): WorkOrderLineAssignmentSelection {
  const { weekStart, weekEnd, liveInvoiceIds, notAfter } = params;
  const jobWindows = params.jobWindows || {};
  const weekly = Boolean(weekStart && weekEnd);
  const assignmentIds: string[] = [];
  const alreadyHeldIds: string[] = [];
  for (const c of params.candidates || []) {
    const date = normalizedLockDate(c.scheduled_date);
    if (weekly) {
      if (!date || date < String(weekStart) || date > String(weekEnd)) continue;
    } else {
      const window = jobWindows[String(c.job_id)];
      if (!window) continue;
      if (!date) continue;
      const upper = window.to < notAfter ? window.to : notAfter;
      if (date < window.from || date > upper) continue;
    }
    const id = String(c.id);
    if (c.invoiced_in && liveInvoiceIds.has(String(c.invoiced_in))) {
      if (!alreadyHeldIds.includes(id)) alreadyHeldIds.push(id);
      continue;
    }
    if (!assignmentIds.includes(id)) assignmentIds.push(id);
  }
  return { assignmentIds, alreadyHeldIds };
}

/**
 * Operator-facing note for in-scope cards a live invoice already holds.
 *
 * They are dropped from this invoice's stamp set, so the money record has to
 * say which ones and why, otherwise a card silently vanishes from the lock.
 */
export function describeAlreadyHeldWorkOrderCards(
  alreadyHeldIds: readonly string[],
  jobLabelById: Readonly<Record<string, string>> = {},
): string {
  const ids = alreadyHeldIds || [];
  if (ids.length === 0) return "";
  const labelled = ids.map((id) => jobLabelById[id] || id);
  return ids.length +
    " job card(s) on this invoice's work-order/commission job(s) are already " +
    "held by another live invoice and were left unstamped: " +
    labelled.join(", ");
}
