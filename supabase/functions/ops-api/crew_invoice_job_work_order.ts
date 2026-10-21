// deno-lint-ignore-file no-explicit-any
// Crew invoices on the job's work order. Contract:
// docs/job-work-order-crew-invoices-v1.md.
//
// Every switch here is missing, unreadable, or false until someone turns it
// on. This module never writes trade_invoice_lines.job_work_order_id and
// never writes source_work_order_id: the database trigger is the stamp, and
// source_work_order_id is the one-invoice-per-crew-work-order fence
// (_findBlockingWorkOrderInvoice, can_invoice, the assignment lock). Travel
// (line type Travel, no source_work_order_id) stays off that fence.

import { isWorkOrderLockLine } from "./trade_invoice_assignment_lock.ts";
import { JOB_WORK_ORDER_OPEN_STATUSES } from "./job_work_order_quote_fill.ts";
import {
  JOB_WORK_ORDER_ALL_TYPES_FLAG,
  readFlag,
} from "./job_work_orders.ts";

export { JOB_WORK_ORDER_ALL_TYPES_FLAG };
export const JOB_WORK_ORDER_ACTIVE_BACKFILL_FLAG =
  "job_work_order_active_backfill_v1";
export const JOB_WORK_ORDER_OFFICE_FILL_FLAG = "job_work_order_office_fill_v1";
export const CREW_INVOICE_ON_JOB_WORK_ORDER_FLAG =
  "crew_invoice_on_job_work_order_v1";
export const CREW_INVOICE_LINE_OFFICE_REVIEW_FLAG =
  "crew_invoice_line_office_review_v1";
export const CREW_INVOICE_REQUIRES_JOB_WORK_ORDER_FLAG =
  "crew_invoice_requires_job_work_order_v1";
export const RETIRE_CREW_WORK_ORDERS_FLAG = "retire_crew_work_orders_v1";

/** Shaun. Primary approver, seeded in work_order_settings.approver_user_ids. */
export const SHAUN_APPROVER_USER_ID = "9913309f-35ae-4a71-8e1f-f704ecc526ea";
/**
 * One users id this repo already names for Marnin. Not a settings seed.
 * Production has two rows on his email; backup_approver_user_ids stays empty
 * until the owner writes the id he chooses.
 */
export const MARNIN_BACKUP_APPROVER_USER_ID =
  "706c5258-70dd-483a-b36c-af6864b24498";

/** 30 * 24 hours, matching Postgres `interval '30 days'`. */
export const ACTIVE_JOB_WORK_ORDER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const QUOTE_FILL_TYPES = new Set(["fencing", "patio"]);

export function jobTypeOpensWorkOrder(
  type: string | null | undefined,
  flagOn: boolean,
): boolean {
  const name = String(type ?? "").trim();
  if (name === "fencing" || name === "patio") return true;
  return flagOn && name !== "";
}

/** Accepted fence and patio quotes still fill the draft. Nothing else does. */
export function jobTypeFillsFromQuote(
  type: string | null | undefined,
): boolean {
  return QUOTE_FILL_TYPES.has(String(type ?? "").trim());
}

/**
 * Readiness "Work order exists" while job_work_order_all_types_v1 is on.
 * A blank or unfilled draft does not pass. Only an approved job work order
 * whose labour allowance is set does. 0 is an explicit fill. A crew work
 * order never passes.
 */
export function filledApprovedJobWorkOrder(
  workOrder: {
    kind?: string | null;
    status?: string | null;
    agreed_labour_ex?: number | null;
  } | null | undefined,
): boolean {
  if (!workOrder) return false;
  if (workOrder.kind != null && workOrder.kind !== "job") return false;
  if (workOrder.status !== "approved") return false;
  return workOrder.agreed_labour_ex !== null &&
    workOrder.agreed_labour_ex !== undefined;
}

export interface ActiveBackfillJob {
  status?: string | null;
  updated_at?: string | null;
  has_job_work_order?: boolean;
}

/**
 * A job the 30-day backfill may open a blank work order for.
 * Activity is jobs.updated_at only. A processing make-safe touched inside
 * the window is included; one last touched before the window is not.
 */
export function isActiveJobWorkOrderBackfillCandidate(
  job: ActiveBackfillJob,
  asOf: Date,
): boolean {
  if (job.has_job_work_order) return false;
  if (!JOB_WORK_ORDER_OPEN_STATUSES.has(String(job.status || ""))) return false;
  if (!job.updated_at) return false;
  const updated = new Date(job.updated_at).getTime();
  if (!Number.isFinite(updated)) return false;
  return updated >= asOf.getTime() - ACTIVE_JOB_WORK_ORDER_WINDOW_MS;
}

export interface StampLine {
  job_id?: string | null;
  line_type?: string | null;
  source_work_order_id?: string | null;
  job_work_order_id?: string | null;
}

/**
 * What the stamp is allowed to change. source_work_order_id is never written.
 * A draft or approved job work order is attached only while the stamp flag
 * is on and the line names a job. The assignment lock still reads
 * source_work_order_id, so travel and a labour line with only the job work
 * order do not lock a day card.
 */
export function planJobWorkOrderStamp(input: {
  stampFlagOn: boolean;
  line: StampLine;
  jobWorkOrderId: string | null;
}): {
  job_work_order_id: string | null;
  source_work_order_id: string | null;
  locksAssignment: boolean;
} {
  const source = input.line.source_work_order_id || null;
  let jobWorkOrderId = input.line.job_work_order_id || null;
  if (
    !jobWorkOrderId && input.stampFlagOn && input.line.job_id &&
    input.jobWorkOrderId
  ) {
    jobWorkOrderId = input.jobWorkOrderId;
  }
  return {
    job_work_order_id: jobWorkOrderId,
    source_work_order_id: source,
    locksAssignment: isWorkOrderLockLine({
      job_id: input.line.job_id,
      line_type: input.line.line_type,
      source_work_order_id: source,
    }),
  };
}

export interface HardRuleLine {
  job_id?: string | null;
  line_type?: string | null;
}

export interface HardRuleRefusal {
  code: "job_work_order_required" | "job_work_order_unreadable";
  error: string;
  job_id?: string;
}

export type JobWorkOrderPresence = { hasWorkOrder: boolean } | "unreadable";

/**
 * The later hard rule. Off: nothing is refused, including travel on a job
 * with no work order. On: a line that names a job with no draft or approved
 * job work order is refused. A line with no job (a deduction, an adjustment)
 * is not. An unreadable read refuses the whole submit.
 */
export function hardRuleRefusal(input: {
  flagOn: boolean;
  lines: readonly HardRuleLine[];
  jobs: Readonly<Record<string, JobWorkOrderPresence>>;
}): HardRuleRefusal | null {
  if (!input.flagOn) return null;
  const jobIds = [
    ...new Set(
      input.lines.map((line) => line.job_id).filter((id): id is string =>
        Boolean(id)
      ),
    ),
  ];
  for (const jobId of jobIds) {
    if (input.jobs[jobId] === "unreadable" || input.jobs[jobId] == null) {
      return {
        code: "job_work_order_unreadable",
        error: "The job work order could not be read. Nothing was saved.",
        job_id: jobId,
      };
    }
  }
  for (const jobId of jobIds) {
    const presence = input.jobs[jobId];
    if (presence !== "unreadable" && !presence.hasWorkOrder) {
      return {
        code: "job_work_order_required",
        error: "This job has no work order, so it cannot be invoiced yet.",
        job_id: jobId,
      };
    }
  }
  return null;
}

export async function loadCrewInvoiceJobWorkOrderRefusal(
  client: any,
  lines: readonly HardRuleLine[],
): Promise<HardRuleRefusal | null> {
  const flagOn = await readFlag(
    client,
    CREW_INVOICE_REQUIRES_JOB_WORK_ORDER_FLAG,
  );
  if (!flagOn) return null;
  const jobIds = [
    ...new Set(
      lines.map((line) => line.job_id).filter((id): id is string =>
        Boolean(id)
      ),
    ),
  ];
  if (jobIds.length === 0) return null;
  try {
    const { data, error } = await client.from("work_orders")
      .select("job_id")
      .in("job_id", jobIds)
      .eq("kind", "job")
      .in("status", ["draft", "approved"]);
    if (error) {
      return {
        code: "job_work_order_unreadable",
        error: "The job work order could not be read. Nothing was saved.",
      };
    }
    const covered = new Set(
      (data || []).map((row: { job_id?: string | null }) => String(row.job_id)),
    );
    const jobs: Record<string, JobWorkOrderPresence> = {};
    for (const jobId of jobIds) jobs[jobId] = { hasWorkOrder: covered.has(jobId) };
    return hardRuleRefusal({ flagOn: true, lines, jobs });
  } catch {
    return {
      code: "job_work_order_unreadable",
      error: "The job work order could not be read. Nothing was saved.",
    };
  }
}

export interface OfficeReviewLine {
  office_review_status?: string | null;
}

export interface XeroSyncRefusal {
  code: "lines_rejected" | "lines_awaiting_office_review";
  error: string;
}

/**
 * Whether this invoice may be copied to Xero. Null (a line from before the
 * review switch) and approved may go. One rejected line, or one line still
 * awaiting or queried, holds the whole invoice: there is no partial bill.
 * Rejected is reported before awaiting.
 */
export function xeroSyncRefusal(
  lines: readonly OfficeReviewLine[],
): XeroSyncRefusal | null {
  const statuses = lines.map((line) => line.office_review_status ?? null);
  if (statuses.some((status) => status === "rejected")) {
    return {
      code: "lines_rejected",
      error:
        "A line on this invoice was rejected. It cannot go to Xero until that line is cleared.",
    };
  }
  if (statuses.some((status) => status === "awaiting" || status === "queried")) {
    return {
      code: "lines_awaiting_office_review",
      error:
        "A line on this invoice is still awaiting office review. It cannot go to Xero yet.",
    };
  }
  return null;
}

/**
 * Hide a legacy per-trade crew work order once retire_crew_work_orders_v1
 * is on. A quote-builder crew row (it carries quote_builder_version_id)
 * stays. A null kind stays. A job work order stays: my_work_orders returns
 * it while this switch is on, and the trade app does not filter by kind.
 */
export function hideRetiredCrewWorkOrder(
  row: { kind?: string | null; quote_builder_version_id?: string | null },
  flagOn: boolean,
): boolean {
  return flagOn && row.kind === "crew" && !row.quote_builder_version_id;
}

export function visibleCrewPayWorkOrders<T extends {
  kind?: string | null;
  quote_builder_version_id?: string | null;
}>(rows: readonly T[], flagOn: boolean): T[] {
  if (!flagOn) return [...rows];
  return rows.filter((row) => !hideRetiredCrewWorkOrder(row, true));
}

export function namedWorkOrderApprover(
  userId: string | null | undefined,
  opts: {
    primaryIds: readonly string[];
    backupIds: readonly string[];
    officeFlagOn: boolean;
  },
): boolean {
  if (!userId) return false;
  if (opts.primaryIds.includes(userId)) return true;
  return opts.officeFlagOn && opts.backupIds.includes(userId);
}

export type OfficeWriteAction = "fill" | "approve" | "review";

export type OfficeWriteDecision =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

/**
 * Fill and approve need the office-fill switch, including for Shaun: the
 * old approve door stays the one he uses while this switch is off.
 * Line review needs the review switch. Shaun is a primary approver either
 * way. Marnin is a backup only while the office-fill switch is on.
 * A server key with no user id is not an approver.
 */
export function decideOfficeWrite(input: {
  staff: boolean;
  userId: string | null;
  action: OfficeWriteAction;
  officeFlagOn: boolean;
  reviewFlagOn: boolean;
  primaryIds: readonly string[];
  backupIds: readonly string[];
}): OfficeWriteDecision {
  if (!input.staff) {
    return {
      ok: false,
      status: 403,
      code: "operator_access_required",
      error: "An authorised operator session is required.",
    };
  }
  if (input.action === "review") {
    if (!input.reviewFlagOn) {
      return {
        ok: false,
        status: 409,
        code: "crew_invoice_line_office_review_off",
        error: "Line review is switched off.",
      };
    }
  } else if (!input.officeFlagOn) {
    return {
      ok: false,
      status: 409,
      code: "job_work_order_office_fill_off",
      error: "Filling and approving blank work orders is switched off.",
    };
  }
  if (
    !namedWorkOrderApprover(input.userId, {
      primaryIds: input.primaryIds,
      backupIds: input.backupIds,
      officeFlagOn: input.officeFlagOn,
    })
  ) {
    return {
      ok: false,
      status: 403,
      code: "not_approver",
      error: "Only a named work-order approver can do this.",
    };
  }
  return { ok: true };
}

const CREW_RETIRED_ERROR =
  "Crew work orders are retired. Send kind: 'job' to open the job's work order.";

/**
 * create_work_order refuses every call that is not kind 'job' while
 * retire_crew_work_orders_v1 is on. A missing kind is the same as a crew
 * kind: cached pages and sw_create_work_order both omit it. The switch off
 * leaves today's crew insert alone.
 */
export function crewWorkOrderCreateRefusal(
  kind: unknown,
  flagOn: boolean,
): { code: "crew_work_order_retired"; error: string } | null {
  if (!flagOn || kind === "job") return null;
  return { code: "crew_work_order_retired", error: CREW_RETIRED_ERROR };
}

/** Closed for the retirement dry-run. Anything else with a status is open. */
const CREW_RETIREMENT_CLOSED_JOB_STATUSES = new Set([
  "complete",
  "completed",
  "invoiced",
  "paid",
  "closed",
  "archived",
  "cancelled",
  "lost",
]);

export interface CrewRetirementRow {
  id: string;
  kind?: string | null;
  quote_builder_version_id?: string | null;
  status?: string | null;
  sent_at?: string | null;
  job_id?: string | null;
  job_status?: string | null;
}

/**
 * What the manual retirement script would cancel. Quote-builder crew rows
 * and job work orders are not in the set. Already-cancelled rows are
 * counted and not cancelled again. The live 34 / 9 / 4 audit is a comment
 * on the script, not a number this function checks.
 */
export function planCrewWorkOrderRetirement(rows: readonly CrewRetirementRow[]): {
  eligible: number;
  already_cancelled: number;
  to_retire: number;
  sent: number;
  with_sent_at: number;
  open_jobs: number;
  closed_jobs: number;
  unknown_job_status: number;
  ids: string[];
} {
  const eligible = rows.filter((row) =>
    row.kind === "crew" && !row.quote_builder_version_id
  );
  const alreadyCancelled = eligible.filter((row) => row.status === "cancelled");
  const toRetire = eligible.filter((row) => row.status !== "cancelled");
  const openJobs = new Set<string>();
  const closedJobs = new Set<string>();
  const unknownJobs = new Set<string>();
  for (const row of toRetire) {
    if (!row.job_id) continue;
    const status = String(row.job_status || "");
    if (!status) unknownJobs.add(row.job_id);
    else if (CREW_RETIREMENT_CLOSED_JOB_STATUSES.has(status)) {
      closedJobs.add(row.job_id);
    } else openJobs.add(row.job_id);
  }
  return {
    eligible: eligible.length,
    already_cancelled: alreadyCancelled.length,
    to_retire: toRetire.length,
    sent: toRetire.filter((row) => row.status === "sent").length,
    with_sent_at: toRetire.filter((row) => Boolean(row.sent_at)).length,
    open_jobs: openJobs.size,
    closed_jobs: closedJobs.size,
    unknown_job_status: unknownJobs.size,
    ids: toRetire.map((row) => row.id),
  };
}

export function decideOfficeQueue(input: {
  staff: boolean;
}): OfficeWriteDecision {
  if (!input.staff) {
    return {
      ok: false,
      status: 403,
      code: "operator_access_required",
      error: "An authorised operator session is required.",
    };
  }
  return { ok: true };
}
