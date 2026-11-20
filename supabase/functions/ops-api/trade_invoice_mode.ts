// How a trade invoices a job (Marnin, 11 Nov 2026). Each job is invoiced ONE
// way, decided by the job (and, for a per-metre trade, by the trade), never
// chosen by the trade on the screen:
//
//   1. the job has a live (not void) group work order -> group work order
//   1b. a restoration job with an approved job work order carrying its agreed
//      labour -> work order (owner, 12 Nov 2026: restoration_work_order.ts;
//      with none it stays hourly)
//   2. the trade is per metre (users.invoice_type = 'per_metre') -> work order
//   3. a patio job -> group work order
//   4. a fencing job -> work order
//   5. everything else (make-safe, repair, other) -> hourly
//
// The job's vertical is read the way the rest of ops-api reads it (repair
// family first: a repair-family card typed makesafe or fencing is repair), so
// the caller passes index.ts's _jobVertical in.
//
// Commission is not a mode. It is an extra line a trade may add only on a job
// they created, a job in a division they manage, or with the office's
// invoice-any-job grant: `can_claim_commission` reads that through the ONE
// rule list in trade_invoice_extra_job_authority.ts, never restated here. On a
// job whose accepted budget stored a commission record (ruling 17 step 2),
// only the salesperson it names may (job_commission.ts).
//
// This module answers the question; the write paths keep their own checks
// (fencing helpers are still paid by the hour on fencing jobs, so no hourly
// line is refused here).
//
// A work-order job with an APPROVED job work order (work_orders.kind = 'job',
// status = 'approved') is billed at its agreed labour (Marnin, 12 Nov 2026):
// the answer carries `work_order_agreed_ex` and `job_work_order_id`, and
// generate_trade_invoice refuses a work-order line on that job at any other
// amount through workOrderAmountRefusal below.
//
// Contract: docs/trade-invoice-mode-v1.md.
// deno-lint-ignore-file no-explicit-any

import { isRestorationCard } from "./restoration_workflow_store.ts";
import {
  commissionOfferFor,
  type CommissionOffer,
  type JobCommissionRecord,
  readJobCommissionRecords,
} from "./job_commission.ts";
import {
  extraLineType,
  tradeMayClaimCommission,
} from "./trade_invoice_extra_job_authority.ts";
import { JobLabourPayReadError, readHourlyCappedJobs } from "./job_labour_cap.ts";
import {
  AdditionalWorkOrderError,
  pickTradeWorkOrder,
  readTradeBilledOnJobs,
  type TradeWorkOrderOption,
} from "./job_additional_work_orders.ts";

export type TradeInvoiceMode = "group_work_order" | "work_order" | "hourly";

export type TradeInvoiceModeReason =
  | "live_group_work_order"
  | "per_metre_trade"
  | "patio_job"
  | "fencing_job"
  | "restoration_work_order"
  | "hourly_capped"
  | "other_job";

export type TradeInvoiceModeDecision = {
  invoice_mode: TradeInvoiceMode;
  invoice_mode_reason: TradeInvoiceModeReason;
};

export type TradeInvoiceJobMode = TradeInvoiceModeDecision & {
  job_id: string;
  can_claim_commission: boolean | null;
  commission: CommissionOffer;
  // Only on a work_order job with an approved job work order that has its
  // agreed labour set: the agreed labour, ex GST, and that work order's id.
  // Otherwise both null. The trade bills the work order at exactly this.
  // With more than one work order on the job (job_additional_work_orders.ts)
  // this is the first one this trade has not billed yet; once every one is
  // billed, the job's main work order (and the cap refuses more).
  work_order_agreed_ex: number | null;
  /** Office amount changes already inside work_order_agreed_ex / cap_agreed_ex.
   *  Present only when non-zero; the cap reads it so it does not add them twice. */
  work_order_office_change_ex?: number;
  job_work_order_id: string | null;
  // The job's main work order and its own agreed labour: what the job-level
  // cap reads (its amount changes carry every additional work order). Only on
  // a job with more than one work order.
  cap_work_order_id?: string | null;
  cap_agreed_ex?: number | null;
  // Every work order on the job this trade may bill, in order, with whether
  // what they billed already covers it. Only on a job with more than one.
  work_orders?: TradeWorkOrderOption[];
  // The cap's read only (includeAdditionalOrders): every approved additional
  // work order on the job, named for a trade or for nobody. Never on an
  // answer a trade reads: it carries other trades' amounts.
  additional_orders?: Array<{ assigned_user_id: string | null; agreed_ex: number }>;
};

/** The owner's rule, in order. Pure. */
export function decideTradeInvoiceMode(input: {
  hasLiveGroupWorkOrder: boolean;
  tradeInvoiceType: string | null | undefined;
  jobVertical: string | null | undefined;
  /** A restoration job whose approved job work order has its agreed labour. */
  restorationWorkOrder?: boolean;
  /** Ruling 17 step 4: the job's newest budget pays the crew hourly up to a
   *  maximum (read only while job_labour_budget_v1 is on). */
  hourlyCapped?: boolean;
}): TradeInvoiceModeDecision {
  if (input.hasLiveGroupWorkOrder) {
    return {
      invoice_mode: "group_work_order",
      invoice_mode_reason: "live_group_work_order",
    };
  }
  if (input.hourlyCapped === true) {
    return { invoice_mode: "hourly", invoice_mode_reason: "hourly_capped" };
  }
  if (input.restorationWorkOrder === true) {
    return { invoice_mode: "work_order", invoice_mode_reason: "restoration_work_order" };
  }
  if (String(input.tradeInvoiceType || "").trim().toLowerCase() === "per_metre") {
    return { invoice_mode: "work_order", invoice_mode_reason: "per_metre_trade" };
  }
  const vertical = String(input.jobVertical || "").trim().toLowerCase();
  if (vertical === "patio") {
    return { invoice_mode: "group_work_order", invoice_mode_reason: "patio_job" };
  }
  if (vertical === "fencing") {
    return { invoice_mode: "work_order", invoice_mode_reason: "fencing_job" };
  }
  return { invoice_mode: "hourly", invoice_mode_reason: "other_job" };
}

/** A group work order holds the job unless it is void (same rule as my_hours). */
export function isLiveGroupWorkOrder(row: any): boolean {
  return !!row?.job_id && String(row?.status || "") !== "void";
}

export class TradeInvoiceModeReadError extends Error {
  constructor(what: string) {
    super(`Could not read ${what} to decide how these jobs are invoiced`);
  }
}

const CHUNK = 50;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Reads the trade, the jobs (inside the trade's company only) and their group
 * work orders, and decides each job. Mode read errors throw
 * TradeInvoiceModeReadError: an unreadable group never reads as "no group".
 * An unreadable commission stays not known, with claim permission unknown.
 * Job ids not found in the trade's company are returned in `not_found`.
 */
export async function loadTradeInvoiceJobModes(
  client: any,
  input: {
    tradeId: string;
    // The caller's company as the auth layer resolved it. When given, the
    // trade's own row must be in it (else nothing is decided).
    orgId?: string | null;
    jobIds: readonly string[];
    jobVertical: (job: any) => string;
    normaliseManagedVerticals: (value: unknown) => string[];
    // The work order cap only (work_order_total_cap.ts): add every approved
    // additional work order of a job that has one, with the trade it is named
    // for. It carries other trades' amounts, so no answer a trade reads ever
    // sets it.
    includeAdditionalOrders?: boolean;
  },
): Promise<{ jobs: TradeInvoiceJobMode[]; not_found: string[] }> {
  const ids = [
    ...new Set(input.jobIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
  if (ids.length === 0) return { jobs: [], not_found: [] };

  const { data: user, error: userError } = await client.from("users")
    .select(
      "id, org_id, invoice_type, managed_verticals, invoice_any_job:trade_details->invoiceAnyJob",
    )
    .eq("id", input.tradeId)
    .maybeSingle();
  if (userError) throw new TradeInvoiceModeReadError("your profile");
  if (!user?.id || !user?.org_id) throw new TradeInvoiceModeReadError("your profile");
  const orgId = String(user.org_id);
  if (input.orgId && String(input.orgId) !== orgId) {
    throw new TradeInvoiceModeReadError("your company");
  }

  const jobs = new Map<string, any>();
  const liveGroupJobs = new Set<string>();
  for (const part of chunks(ids)) {
    const [jobsRes, groupsRes] = await Promise.all([
      client.from("jobs")
        .select("id, org_id, type, job_number, metadata, created_by")
        .eq("org_id", orgId)
        .in("id", part),
      client.from("group_work_orders")
        .select("job_id, status")
        .in("job_id", part),
    ]);
    if (jobsRes.error) throw new TradeInvoiceModeReadError("the jobs");
    if (groupsRes.error) throw new TradeInvoiceModeReadError("the group work orders");
    for (const row of jobsRes.data || []) {
      if (row?.id && String(row.org_id || orgId) === orgId) jobs.set(String(row.id), row);
    }
    for (const row of groupsRes.data || []) {
      if (isLiveGroupWorkOrder(row)) liveGroupJobs.add(String(row.job_id));
    }
  }

  // The approved job work order of every work-order job: its agreed labour is
  // what the trade bills. Read only for jobs invoiced as a work order, and for
  // restoration jobs (whose mode it decides). More than one approved job work
  // order on a job is never guessed between.
  const agreedByJob = new Map<string, { id: string; agreed: number; officeChange?: number }>();
  // Every approved work order (main and additional) on those jobs, for the
  // trade's pick (pickTradeWorkOrder).
  const ordersByJob = new Map<string, any[]>();
  const readAgreed = async (jobIds: string[]) => {
    for (const part of chunks(jobIds.filter((id) => !agreedReadFor.has(id)))) {
      for (const id of part) agreedReadFor.add(id);
      await readAgreedPart(part);
    }
  };
  const agreedReadFor = new Set<string>();
  const restorationJobIds = ids.filter((id) => jobs.has(id) && isRestorationCard(jobs.get(id)));
  const decided = new Map<string, TradeInvoiceModeDecision & { vertical: string }>();
  const decideAll = () => {
    for (const id of ids) {
      const row = jobs.get(id);
      if (!row) continue;
      const vertical = input.jobVertical(row);
      decided.set(id, {
        ...decideTradeInvoiceMode({
          hasLiveGroupWorkOrder: liveGroupJobs.has(id),
          tradeInvoiceType: user.invoice_type,
          jobVertical: vertical,
          restorationWorkOrder: restorationJobIds.includes(id) && agreedByJob.has(id),
          hourlyCapped: hourlyCappedJobs.has(id),
        }),
        vertical,
      });
    }
  };
  const readAgreedPart = async (part: string[]) => {
    const { data, error } = await client.from("work_orders")
      .select("id, job_id, kind, wo_number, title, agreed_labour_ex, approved_at, assigned_user_id, amount_change_id")
      .eq("org_id", orgId)
      .in("kind", ["job", "additional"])
      .eq("status", "approved")
      .in("job_id", part);
    if (error) throw new TradeInvoiceModeReadError("the job work orders");
    await applyOfficeAmountChanges(client, data || []);
    const seen = new Set<string>();
    for (const row of data || []) {
      const jobId = String(row?.job_id || "");
      if (!jobId) continue;
      if (!ordersByJob.has(jobId)) ordersByJob.set(jobId, []);
      ordersByJob.get(jobId)!.push(row);
      if (row?.kind !== "job") continue;
      if (seen.has(jobId)) throw new TradeInvoiceModeReadError("the job work orders");
      seen.add(jobId);
      const raw = row?.agreed_labour_ex;
      const agreed = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
      if (row?.id && Number.isFinite(agreed) && agreed >= 0) {
        agreedByJob.set(jobId, {
          id: String(row.id),
          agreed: Math.round(agreed * 100) / 100,
          officeChange: Number(row.office_change_ex) || 0,
        });
      }
    }
  };
  // Ruling 17 step 4: a job whose newest budget pays hourly up to a maximum
  // is invoiced by the hour (the database holds it to the maximum). Empty
  // while job_labour_budget_v1 is off; an unreadable budget never reads as
  // "no budget".
  let hourlyCappedJobs: Set<string>;
  try {
    hourlyCappedJobs = await readHourlyCappedJobs(client, ids.filter((id) => jobs.has(id)));
  } catch (error) {
    if (error instanceof JobLabourPayReadError) throw new TradeInvoiceModeReadError("the job budgets");
    throw error;
  }
  await readAgreed(restorationJobIds);
  decideAll();
  await readAgreed(
    [...decided.entries()].filter(([, d]) => d.invoice_mode === "work_order").map(([id]) => id),
  );

  // A job with an additional work order: which one this trade bills next
  // depends on what they have billed there. Read only for those jobs.
  const multiJobs = [...ordersByJob.entries()]
    .filter(([id, rows]) => agreedByJob.has(id) && rows.some((r: any) => r?.kind === "additional"))
    .map(([id]) => id);
  let billedByJob = new Map<string, number>();
  if (multiJobs.length > 0) {
    try {
      billedByJob = await readTradeBilledOnJobs(client, input.tradeId, multiJobs);
    } catch (error) {
      if (error instanceof AdditionalWorkOrderError) throw new TradeInvoiceModeReadError("what you have billed on these jobs");
      throw error;
    }
  }

  const trade = {
    id: String(user.id),
    orgId,
    managedVerticals: input.normaliseManagedVerticals(user.managed_verticals),
    invoiceAnyJob: user.invoice_any_job === true,
  };
  let commissionRecords = new Map<string, JobCommissionRecord>();
  let commissionUnavailable = false;
  try {
    commissionRecords = await readJobCommissionRecords(client, [...jobs.keys()]);
  } catch (error) {
    console.error("[ops-api] trade invoice job modes: commission unreadable", error);
    commissionUnavailable = true;
  }
  const out: TradeInvoiceJobMode[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const row = jobs.get(id);
    const decision = decided.get(id);
    if (!row || !decision) {
      notFound.push(id);
      continue;
    }
    const { vertical, ...mode } = decision;
    const agreed = mode.invoice_mode === "work_order" ? agreedByJob.get(id) : undefined;
    const pick = agreed
      ? pickTradeWorkOrder(ordersByJob.get(id) || [], input.tradeId, billedByJob.get(id) ?? 0)
      : null;
    // One work order (every job before 19 Nov 2026): exactly as before.
    const next = pick && pick.options.length > 1 ? pick.open : null;
    out.push({
      job_id: id,
      ...mode,
      work_order_agreed_ex: next ? next.agreed_ex : agreed ? agreed.agreed : null,
      job_work_order_id: next ? next.id : agreed ? agreed.id : null,
      ...(agreed && agreed.officeChange ? { work_order_office_change_ex: agreed.officeChange } : {}),
      // Only a job with more than one work order carries these, so every
      // other answer is byte for byte what it was.
      ...(pick && pick.options.length > 1
        ? {
          cap_work_order_id: agreed!.id,
          cap_agreed_ex: agreed!.agreed,
          work_orders: pick.options,
        }
        : {}),
      ...(input.includeAdditionalOrders && multiJobs.includes(id)
        ? { additional_orders: additionalOrdersOf(ordersByJob.get(id) || []) }
        : {}),
      commission: commissionOfferFor(commissionRecords.get(id) ?? null, input.tradeId),
      can_claim_commission: commissionUnavailable ? null : tradeMayClaimCommission({
        job: {
          id,
          createdBy: row.created_by ? String(row.created_by) : null,
          vertical,
          commission: commissionRecords.has(id)
            ? { salespersonUserId: commissionRecords.get(id)!.salesperson_user_id }
            : null,
        },
        trade,
      }),
    });
  }
  return { jobs: out, not_found: notFound };
}

/** A main job work order's agreed labour is its sealed amount plus every
 *  office amount change on it (change_work_order_amount), the same total the
 *  work order cap reads (work_order_total_cap.ts). An additional work order's
 *  approval also writes an amount change on the main order; that one is the
 *  additional order's own money, so it is left out here. Mutates the rows'
 *  agreed_labour_ex so every reader below sees one figure. Unreadable changes
 *  fail closed. */
async function applyOfficeAmountChanges(client: any, rows: any[]): Promise<void> {
  const mains = rows.filter((r) => r?.kind === "job" && r?.id);
  if (mains.length === 0) return;
  const additionalChangeIds = new Set(
    rows.filter((r) => r?.kind === "additional" && r?.amount_change_id).map((r) => String(r.amount_change_id)),
  );
  const { data, error } = await client.from("work_order_amount_changes")
    .select("id, work_order_id, delta_ex")
    .eq("kind", "amount")
    .in("work_order_id", mains.map((r) => String(r.id)))
    .order("id")
    .range(0, 999);
  if (error || (data || []).length >= 1000) throw new TradeInvoiceModeReadError("the work order changes");
  const delta = new Map<string, number>();
  for (const c of data || []) {
    if (additionalChangeIds.has(String(c.id))) continue;
    const d = Number(c.delta_ex);
    if (!Number.isFinite(d)) throw new TradeInvoiceModeReadError("the work order changes");
    delta.set(String(c.work_order_id), (delta.get(String(c.work_order_id)) ?? 0) + d);
  }
  for (const row of mains) {
    const d = delta.get(String(row.id));
    if (d === undefined) continue;
    const base = Number(row.agreed_labour_ex);
    if (!Number.isFinite(base)) continue;
    row.agreed_labour_ex = Math.round((base + d) * 100) / 100;
    row.office_change_ex = Math.round(d * 100) / 100;
  }
}

/** Pure. A job's approved additional work orders, for the cap: the trade
 *  each is named for (null: nobody) and its agreed labour. A row with no
 *  readable amount is not one (it is never offered either). */
function additionalOrdersOf(rows: readonly any[]): Array<{ assigned_user_id: string | null; agreed_ex: number }> {
  const out: Array<{ assigned_user_id: string | null; agreed_ex: number }> = [];
  for (const row of rows) {
    if (row?.kind !== "additional") continue;
    const raw = row?.agreed_labour_ex;
    const agreed = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(agreed) || agreed < 0) continue;
    out.push({
      assigned_user_id: row?.assigned_user_id ? String(row.assigned_user_id) : null,
      agreed_ex: Math.round(agreed * 100) / 100,
    });
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TRADE_INVOICE_JOB_MODES_MAX = 50;

export class TradeInvoiceJobModesRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** `job_ids` query value: comma-separated job uuids, 1 to 50, deduplicated. */
export function parseTradeInvoiceJobModeIds(raw: string | null | undefined): string[] {
  const ids = [
    ...new Set(
      String(raw || "").split(",").map((id) => id.trim()).filter(Boolean),
    ),
  ];
  if (ids.length === 0) {
    throw new TradeInvoiceJobModesRequestError(
      "job_ids_required",
      "Name at least one job (job_ids).",
    );
  }
  if (ids.length > TRADE_INVOICE_JOB_MODES_MAX) {
    throw new TradeInvoiceJobModesRequestError(
      "too_many_job_ids",
      `Ask about at most ${TRADE_INVOICE_JOB_MODES_MAX} jobs at a time.`,
    );
  }
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length > 0) {
    throw new TradeInvoiceJobModesRequestError(
      "job_ids_invalid",
      "One of those jobs is not a job id.",
    );
  }
  return ids;
}

// ── The agreed work-order amount (Marnin, 12 Nov 2026) ───────────────────────

/**
 * A line that bills a work order: the Pay tab's work-order row
 * (row_type 'work_order'), a row carrying named labour lines, or a line whose
 * type is a work order. The agreed-amount rule reads it; hourly, travel,
 * materials and commission lines are not work-order lines.
 */
export function isWorkOrderInvoiceItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  if (item.row_type === "work_order") return true;
  if (Array.isArray(item.wo_labour_lines) && item.wo_labour_lines.length > 0) return true;
  const type = extraLineType(item);
  return type === "work order" || type === "work_order";
}

export type WorkOrderAmountLine = {
  // The job number (or the reference the line named) for the message.
  ref: string;
  jobId: string;
  // What the trade put on the line as the work order's amount, ex GST.
  woAllocated: unknown;
};

export type WorkOrderAmountRefusal = {
  code: "work_order_amount_not_agreed";
  message: string;
  jobs: Array<{ job: string; job_id: string; agreed_ex: number; billed_ex: number | null }>;
};

function dollars(value: number): string {
  const fixed = (Math.round(value * 100) / 100).toFixed(2);
  const [whole, cents] = fixed.split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/**
 * Pure. Every work-order line on a job with an agreed work order must carry
 * exactly the agreed amount (within a cent), and such a job is billed as a
 * work order once per invoice. null when every line agrees. Labour lines and
 * pass-throughs on the row still come off it as before; this checks only the
 * work order's amount the row starts from.
 */
export function workOrderAmountRefusal(
  lines: readonly WorkOrderAmountLine[],
  modes: ReadonlyMap<string, Pick<TradeInvoiceJobMode, "work_order_agreed_ex">>,
): WorkOrderAmountRefusal | null {
  const refused = new Map<string, WorkOrderAmountRefusal["jobs"][number]>();
  const seen = new Set<string>();
  for (const line of lines) {
    const agreed = modes.get(line.jobId)?.work_order_agreed_ex ?? null;
    if (agreed === null) continue;
    const raw = line.woAllocated;
    const billed = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    const twice = seen.has(line.jobId);
    seen.add(line.jobId);
    if (!twice && Number.isFinite(billed) && Math.abs(billed - agreed) <= 0.01) continue;
    if (!refused.has(line.jobId)) {
      refused.set(line.jobId, {
        job: line.ref,
        job_id: line.jobId,
        agreed_ex: agreed,
        billed_ex: Number.isFinite(billed) ? Math.round(billed * 100) / 100 : null,
      });
    }
  }
  if (refused.size === 0) return null;
  const jobs = [...refused.values()];
  const message = jobs.map((j) =>
    `Job ${j.job} has an agreed work order of ${dollars(j.agreed_ex)}. Bill it at that amount, or ask the office.`
  ).join(" ");
  return { code: "work_order_amount_not_agreed", message, jobs };
}
