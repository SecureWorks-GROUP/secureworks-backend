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
 * The one live users row for Marnin, role admin. Measured 21 Oct 2026:
 * public.users created 1 Mar 2026 5:17 PM AWST, auth created 1 Mar 2026
 * 5:01 PM AWST, last sign-in 12 Oct 2026 11:19 AM AWST, email
 * marnin@secureworkswa.com.au. Not a settings seed.
 * backup_approver_user_ids ships empty until the owner writes
 * backup_approver_user_ids = [this id].
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
  has_job_work_order?: boolean;
  /** Assignment, time entry, invoice line, or status-change instants. */
  activity_at?: Array<string | null | undefined> | null;
}

/**
 * A job the 30-day backfill may open a blank work order for.
 * Activity is a real assignment, time entry, invoice line or status change.
 * jobs.updated_at does not qualify, even when it is recent. A processing
 * make-safe with activity inside the window is included.
 */
export function isActiveJobWorkOrderBackfillCandidate(
  job: ActiveBackfillJob,
  asOf: Date,
): boolean {
  if (job.has_job_work_order) return false;
  if (!JOB_WORK_ORDER_OPEN_STATUSES.has(String(job.status || ""))) return false;
  const times = (job.activity_at || [])
    .map((value) => new Date(String(value ?? "")).getTime())
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return false;
  const newest = Math.max(...times);
  return newest >= asOf.getTime() - ACTIVE_JOB_WORK_ORDER_WINDOW_MS;
}

const REVIEWED_BACKFILL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids --apply may open. A reviewed dry-run file is `{ job_ids: [...] }`
 * or a raw uuid array. Missing, empty, or any non-uuid is null: apply refuses.
 */
export function reviewedBackfillJobIds(payload: unknown): string[] | null {
  let raw: unknown[] | null = null;
  if (Array.isArray(payload)) raw = payload;
  else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const jobIds = (payload as { job_ids?: unknown }).job_ids;
    if (Array.isArray(jobIds)) raw = jobIds;
  }
  if (!raw || raw.length === 0) return null;
  const ids = raw.map((id) => String(id).trim());
  if (ids.some((id) => !REVIEWED_BACKFILL_UUID.test(id))) return null;
  return ids;
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

export type JobWorkOrderPresence =
  | { hasWorkOrder: boolean; open?: boolean }
  | "unreadable";

function isTravelLine(line: HardRuleLine): boolean {
  return String(line.line_type || "").trim().toLowerCase() === "travel";
}

/**
 * The later hard rule. Off: nothing is refused.
 * On (DEFAULT, owner to confirm): only an open job's non-travel line needs
 * a draft or approved job work order. A closed job is exempt. Travel is
 * exempt, including when that job cannot be read, unless the same job also
 * has a non-travel line. A missing `open` is treated as open. A line with
 * no job is not refused. An unreadable job refuses a non-travel line.
 */
export function hardRuleRefusal(input: {
  flagOn: boolean;
  lines: readonly HardRuleLine[];
  jobs: Readonly<Record<string, JobWorkOrderPresence>>;
}): HardRuleRefusal | null {
  if (!input.flagOn) return null;
  const byJob = new Map<string, HardRuleLine[]>();
  for (const line of input.lines) {
    if (!line.job_id) continue;
    const list = byJob.get(line.job_id) || [];
    list.push(line);
    byJob.set(line.job_id, list);
  }
  for (const [jobId, lines] of byJob) {
    if (!lines.some((line) => !isTravelLine(line))) continue;
    const presence = input.jobs[jobId];
    if (presence === "unreadable" || presence == null) {
      return {
        code: "job_work_order_unreadable",
        error: "The job work order could not be read. Nothing was saved.",
        job_id: jobId,
      };
    }
    if (presence.open === false) continue;
    if (!presence.hasWorkOrder) {
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
  const nonTravelJobIds = jobIds.filter((jobId) =>
    lines.some((line) => line.job_id === jobId && !isTravelLine(line))
  );
  const unreadable = {
    code: "job_work_order_unreadable" as const,
    error: "The job work order could not be read. Nothing was saved.",
  };
  try {
    const { data, error } = await client.from("work_orders")
      .select("job_id")
      .in("job_id", jobIds)
      .eq("kind", "job")
      .in("status", ["draft", "approved"]);
    if (error) return nonTravelJobIds.length === 0 ? null : unreadable;
    const covered = new Set(
      (data || []).map((row: { job_id?: string | null }) => String(row.job_id)),
    );
    const statusByJob = new Map<string, string>();
    if (nonTravelJobIds.length > 0) {
      const { data: jobRows, error: jobErr } = await client.from("jobs")
        .select("id, status")
        .in("id", nonTravelJobIds);
      if (jobErr) return unreadable;
      for (const row of jobRows || []) {
        statusByJob.set(String(row.id), String(row.status || ""));
      }
    }
    const jobs: Record<string, JobWorkOrderPresence> = {};
    for (const jobId of jobIds) {
      if (!nonTravelJobIds.includes(jobId)) {
        jobs[jobId] = { hasWorkOrder: covered.has(jobId), open: false };
        continue;
      }
      if (!statusByJob.has(jobId)) {
        jobs[jobId] = "unreadable";
        continue;
      }
      jobs[jobId] = {
        hasWorkOrder: covered.has(jobId),
        open: JOB_WORK_ORDER_OPEN_STATUSES.has(statusByJob.get(jobId) || ""),
      };
    }
    return hardRuleRefusal({ flagOn: true, lines, jobs });
  } catch {
    return nonTravelJobIds.length === 0 ? null : unreadable;
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
 * A per-metre trade's weekly crew work order. DEFAULT, pending Marnin:
 * retirement must not hide, cancel, or refuse this path. A quote-builder
 * crew row is not this, even when its assignee is per-metre.
 */
export function perMetreWeeklyCrewWorkOrder(row: {
  kind?: string | null;
  quote_builder_version_id?: string | null;
  assignee_invoice_type?: string | null;
}): boolean {
  return row.kind === "crew" &&
    !row.quote_builder_version_id &&
    row.assignee_invoice_type === "per_metre";
}

/**
 * Hide a legacy per-trade crew work order once retire_crew_work_orders_v1
 * is on. A quote-builder crew row (it carries quote_builder_version_id)
 * stays. A per-metre weekly crew row stays. A null kind stays. A job work
 * order stays: my_work_orders returns it while this switch is on, and the
 * trade app does not filter by kind.
 */
export function hideRetiredCrewWorkOrder(
  row: {
    kind?: string | null;
    quote_builder_version_id?: string | null;
    assignee_invoice_type?: string | null;
  },
  flagOn: boolean,
): boolean {
  if (perMetreWeeklyCrewWorkOrder(row)) return false;
  return flagOn && row.kind === "crew" && !row.quote_builder_version_id;
}

export function visibleCrewPayWorkOrders<T extends {
  kind?: string | null;
  quote_builder_version_id?: string | null;
  assignee_invoice_type?: string | null;
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

/** A line the review door must still be able to move after the flag is turned off. */
export function officeReviewLineIsHeld(
  status: string | null | undefined,
): boolean {
  return status === "awaiting" || status === "queried" || status === "rejected";
}

/**
 * Fill and approve need the office-fill switch and a named approver,
 * including for Shaun: the old approve door stays the one he uses while
 * this switch is off. Marnin is a backup only while the office-fill switch
 * is on.
 *
 * Line review (DEFAULT, owner to confirm) is any office role
 * (admin, owner, ops_manager) with a user id. It does not use the named
 * approver list. The review switch must be on, unless the line is already
 * awaiting, queried or rejected: turning the switch off later does not
 * stick those lines or release them. A null stamp while the switch is off
 * is still refused. A server key with no user id is not a reviewer.
 *
 * DEFAULT, pending Marnin: the person who submitted the invoice cannot
 * review its crew lines, including a line already held after the switch
 * is turned off. A null submitter does not block.
 */
export function decideOfficeWrite(input: {
  staff: boolean;
  userId: string | null;
  action: OfficeWriteAction;
  officeFlagOn: boolean;
  reviewFlagOn: boolean;
  primaryIds: readonly string[];
  backupIds: readonly string[];
  lineAlreadyHeld?: boolean;
  invoiceSubmitterId?: string | null;
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
    if (!input.userId) {
      return {
        ok: false,
        status: 403,
        code: "not_approver",
        error: "Line review needs an office session.",
      };
    }
    if (input.invoiceSubmitterId && input.userId === input.invoiceSubmitterId) {
      return {
        ok: false,
        status: 403,
        code: "self_approval_forbidden",
        error: "An approver cannot review crew lines on an invoice they submitted.",
      };
    }
    if (input.reviewFlagOn || input.lineAlreadyHeld) return { ok: true };
    return {
      ok: false,
      status: 409,
      code: "crew_invoice_line_office_review_off",
      error: "Line review is switched off.",
    };
  }
  if (!input.officeFlagOn) {
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

/** What list_trade_invoice_lines and job_detail publish. The column stays office_review_status. */
export function reviewStateFromOfficeStatus(
  status: string | null | undefined,
): "held" | "approved" | "queried" | "rejected" | null {
  if (status === "awaiting") return "held";
  if (status === "approved") return "approved";
  if (status === "queried") return "queried";
  if (status === "rejected") return "rejected";
  return null;
}

export type InvoiceOfficeReview =
  | { ok: true; hold: XeroSyncRefusal | null }
  | { ok: false; code: "office_review_unreadable" };

/**
 * Saved line review, read whether or not the review flag can be read.
 * A failed read fails closed. NULL stamps do not hold.
 */
export async function readInvoiceOfficeReview(
  client: any,
  invoiceId: string,
): Promise<InvoiceOfficeReview> {
  try {
    const { data, error } = await client.from("trade_invoice_lines")
      .select("office_review_status")
      .eq("trade_invoice_id", invoiceId);
    if (error) return { ok: false, code: "office_review_unreadable" };
    return { ok: true, hold: xeroSyncRefusal(data || []) };
  } catch {
    return { ok: false, code: "office_review_unreadable" };
  }
}

const JOB_WORK_ORDER_TRADE_MONEY_KEYS = [
  "trade_allocation_ex",
  "customer_price_ex",
  "customer_variations_ex",
  "customer_variations_price_ex",
  "agreed_labour_ex",
  "agreed_total_ex",
  "agreed_ex",
  "remaining_ex",
  "billed_to_date_ex",
  "figures",
  "rate",
  "total",
  "price",
  "quote_cost_ex",
  "unit_price",
  "amount",
  "amount_ex",
  "cost",
  "sealed_content_hash",
  "line_total_ex",
  "unit_rate",
  "hourly_rate",
  "subtotal",
  "gst",
] as const;

function withoutTradeMoney(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  for (const key of JOB_WORK_ORDER_TRADE_MONEY_KEYS) delete copy[key];
  if (copy.addendum && typeof copy.addendum === "object" && !Array.isArray(copy.addendum)) {
    copy.addendum = withoutTradeMoney(copy.addendum as Record<string, unknown>);
  }
  return copy;
}

/**
 * A job work order on my_work_orders once crew work orders are retired.
 * Description, quantity and hours stay. Prices, rates, totals and addendum
 * prices do not. The card cannot be invoiced from this list.
 */
export function stripJobWorkOrderCardMoney<T extends Record<string, unknown>>(
  card: T,
): T {
  const next: Record<string, unknown> = { ...card };
  if (Array.isArray(next.scope_items)) {
    next.scope_items = next.scope_items.map((item) =>
      item && typeof item === "object"
        ? withoutTradeMoney(item as Record<string, unknown>)
        : item
    );
  }
  if (Array.isArray(next.negative_charges)) {
    next.negative_charges = next.negative_charges.map((item) =>
      item && typeof item === "object"
        ? withoutTradeMoney(item as Record<string, unknown>)
        : item
    );
  }
  if (Array.isArray(next.addenda)) {
    next.addenda = next.addenda.map((item) =>
      item && typeof item === "object"
        ? withoutTradeMoney(item as Record<string, unknown>)
        : item
    );
  }
  for (const key of JOB_WORK_ORDER_TRADE_MONEY_KEYS) delete next[key];
  next.subtotal = null;
  next.gst = null;
  next.total = null;
  next.available_negative_charge_total_ex = null;
  next.can_invoice = false;
  next.can_add_to_weekly_invoice = false;
  return next as T;
}

const CREW_RETIRED_ERROR =
  "Crew work orders are retired. Send kind: 'job' to open the job's work order.";

/**
 * create_work_order refuses every call that is not kind 'job' while
 * retire_crew_work_orders_v1 is on. A missing kind is the same as a crew
 * kind: cached pages and sw_create_work_order both omit it. The switch off
 * leaves today's crew insert alone.
 *
 * DEFAULT, pending Marnin: a per-metre assignee may still open a crew work
 * order, including when kind is omitted. A missing invoice type still
 * refuses. Quote-builder create does not pass a type, so it stays refused.
 */
export function crewWorkOrderCreateRefusal(
  kind: unknown,
  flagOn: boolean,
  assigneeInvoiceType?: string | null,
): { code: "crew_work_order_retired"; error: string } | null {
  if (!flagOn || kind === "job") return null;
  if (assigneeInvoiceType === "per_metre") return null;
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
  assignee_invoice_type?: string | null;
}

/**
 * What the manual retirement script would cancel. Quote-builder crew rows,
 * job work orders, and a per-metre trade's weekly crew rows are not in the
 * set. Already-cancelled rows are counted and not cancelled again. The live
 * 34 / 9 / 4 audit is a comment on the script, not a number this function
 * checks.
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
  kept_per_metre: number;
  ids: string[];
} {
  const keptPerMetre = rows.filter((row) => perMetreWeeklyCrewWorkOrder(row));
  const eligible = rows.filter((row) =>
    row.kind === "crew" &&
    !row.quote_builder_version_id &&
    !perMetreWeeklyCrewWorkOrder(row)
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
    kept_per_metre: keptPerMetre.length,
    ids: toRetire.map((row) => row.id),
  };
}

/** Saved on the invoice when the line review could not be read after save. */
export const OFFICE_REVIEW_UNREADABLE_RETRY_NOTE =
  "The office review on this invoice could not be read. It was saved and was not sent to Xero.";

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
