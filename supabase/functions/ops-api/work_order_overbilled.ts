// Jobs billed over their agreed labour (follow-up 49 item 9(d)): the office's
// first overcharge review. A read only: it writes nothing, sends nothing and
// needs no switch.
//
// The list is driven by the jobs a trade billed in a window (90 days unless the
// caller says otherwise), never by every work order ever approved: only those
// jobs' work orders are read, at most OVERBILLED_MAX_JOBS of them, and a window
// that holds more is refused in words, never cut short. A job billed in the
// window with no agreed amount cannot be judged and is listed apart.
//
// One row per approved job work order whose job has been billed more than the
// work order's agreed labour (work_orders.agreed_labour_ex). "Billed" is the
// one count the live cap refuses by: withWorkOrderCaps -> readWorkOrderCapFacts
// in work_order_total_cap.ts (a billed invoice status, the office's
// override_amount before line_total_ex, every line type except commission and
// reimbursement). This file never re-derives it, so when that count changes
// (P1-05.9's shared database sum behind trade_line_hold_v1) this list follows.
//
// Each row names the job and four job-level figures: agreed, billed, the gap
// (billed less agreed) and what the cap allows (agreed plus approved customer
// variations plus office amount changes; on a job paid hourly up to a sealed
// maximum, that maximum). No trade, rate, hours, invoice or line ever leaves
// this file: rows are built field by field, never by spreading a read.
//
// Staff only (the ops key or a staff session), GET only. A failed read refuses
// (503); it never answers an empty list.
// deno-lint-ignore-file no-explicit-any

import { JOB_WORK_ORDER_BILLED_INVOICE_STATUSES } from "./job_work_orders.ts";
import { countsAgainstWorkOrder, withWorkOrderCaps } from "./work_order_total_cap.ts";

export const OVERBILLED_ACTION = "list_overbilled_job_work_orders";

export class OverbilledReadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type OverbilledJob = {
  job_id: string;
  job_number: string | null;
  work_order_id: string;
  agreed_labour_ex: number;
  billed_ex: number;
  /** billed_ex less agreed_labour_ex; always more than 0 on a listed row. */
  gap_ex: number;
  /** What the cap allows: agreed plus approved customer variations plus
   *  office amount changes (or the hourly maximum on an hourly capped job). */
  allowed_ex: number;
  /** billed_ex less allowed_ex, 0 when the allowance covers the bill. */
  over_allowed_ex: number;
  /** True when approved variations or office changes cover the whole gap. */
  within_allowed: boolean;
  limit: "hourly_maximum" | null;
};

const cents = (v: number) => Math.round(v * 100);
const fromCents = (c: number) => c / 100;

function finiteMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure. The rows of a capped listing (withWorkOrderCaps) whose billed total is
 * more than the agreed labour, largest gap first, then job number. A row with
 * no cap (not approved, no agreed labour) is not listed.
 */
export function overbilledFromCappedListing(
  workOrders: readonly any[],
): OverbilledJob[] {
  const out: OverbilledJob[] = [];
  for (const row of workOrders) {
    const cap = row?.cap;
    if (!cap || typeof cap !== "object") continue;
    const agreed = finiteMoney(row?.agreed_labour_ex);
    const billed = finiteMoney(cap.billed_ex);
    const allowed = finiteMoney(cap.allowed_ex);
    if (agreed === null || billed === null || allowed === null) {
      throw new OverbilledReadError(
        503,
        "overbilled_unreadable",
        "Billed totals could not be read. Try again in a minute.",
      );
    }
    const gap = cents(billed) - cents(agreed);
    if (gap <= 0) continue;
    const overAllowed = Math.max(0, cents(billed) - cents(allowed));
    out.push({
      job_id: String(row.job_id),
      job_number: row?.job_number == null ? null : String(row.job_number),
      work_order_id: String(row.id),
      agreed_labour_ex: fromCents(cents(agreed)),
      billed_ex: fromCents(cents(billed)),
      gap_ex: fromCents(gap),
      allowed_ex: fromCents(cents(allowed)),
      over_allowed_ex: fromCents(overAllowed),
      within_allowed: overAllowed === 0,
      limit: cap.limit === "hourly_maximum" ? "hourly_maximum" : null,
    });
  }
  out.sort((a, b) =>
    b.gap_ex - a.gap_ex ||
    String(a.job_number ?? a.job_id).localeCompare(
      String(b.job_number ?? b.job_id),
    )
  );
  return out;
}

function unreadable(what: string): OverbilledReadError {
  return new OverbilledReadError(
    503,
    "overbilled_unreadable",
    `${what} could not be read. Try again in a minute.`,
  );
}

/** Default window: jobs a trade billed in the last 90 days. */
export const OVERBILLED_DEFAULT_DAYS = 90;
/** The widest window a caller may ask for. */
export const OVERBILLED_MAX_DAYS = 366;
/** Hard cap on the jobs one call checks. A window that holds more is refused
 *  with `overbilled_window_too_wide`; the list is never cut short. */
export const OVERBILLED_MAX_JOBS = 500;
/** The cap reader is fed this many work orders a call, the size it was planned for. */
const CAP_BATCH = 25;
const PAGE = 1000;

function tooWide(days: number): OverbilledReadError {
  return new OverbilledReadError(
    422,
    "overbilled_window_too_wide",
    `More than ${OVERBILLED_MAX_JOBS} jobs were billed in the last ${days} days. Narrow the window (days) and try again.`,
  );
}

/** Pure. `days` as asked: absent is the default; anything but a whole number
 *  from 1 to OVERBILLED_MAX_DAYS is refused 400. */
export function overbilledWindowDays(raw: unknown): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return OVERBILLED_DEFAULT_DAYS;
  }
  const text = String(raw).trim();
  const days = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > OVERBILLED_MAX_DAYS) {
    throw new OverbilledReadError(
      400,
      "invalid_days",
      `days must be a whole number from 1 to ${OVERBILLED_MAX_DAYS}`,
    );
  }
  return days;
}

/** Every page of one bounded read, in id order. A failed page refuses. */
async function readAll(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: any; error: any }>,
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0;; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1);
    if (error || !Array.isArray(data)) throw unreadable(what);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

/**
 * The jobs a trade billed in the window: every job with a line that counts
 * against a work order (not commission, not reimbursement) on a billed invoice
 * (JOB_WORK_ORDER_BILLED_INVOICE_STATUSES, never a holding invoice) dated in
 * the window. This only picks WHICH jobs to check; what is billed on each is
 * still the cap's own all-time count.
 *
 * trade_invoices has no index on a date alone, so the read goes through the
 * people: users (a small table), then their invoices 50 people at a time by
 * trade_invoices_user_week_end_idx (user_id, week_end), in two legs:
 *   - a weekly invoice whose week ended in the window (week_end >= the day);
 *   - an invoice with no week (a work order invoice): week_end IS NULL by the
 *     same index, its sent (else created) time checked here, in code.
 * Both legs page in (user_id, id) order: ordered by id alone, the planner walks
 * the primary key and filters instead of using that index (planned 18 Nov).
 * The no-week leg reads every no-week invoice those people ever sent, by the
 * index; a date index would bound it and is a follow-up, not part of this read.
 * Then those invoices' lines, 100 invoices at a time, by idx_inv_lines_invoice.
 *
 * Stops and refuses the moment the window holds more than OVERBILLED_MAX_JOBS
 * jobs. Only invoices and jobs INSIDE the window count toward that cap, so a
 * narrower window always helps.
 */
async function readJobsBilledInWindow(
  client: any,
  days: number,
  now: Date,
): Promise<{ jobIds: string[]; from: string }> {
  const fromInstant = now.getTime() - days * 86_400_000;
  const from = new Date(fromInstant).toISOString().slice(0, 10);
  const users = await readAll("The people who bill", (a, b) =>
    client.from("users").select("id").order("id", { ascending: true }).range(a, b));
  const userIds = [...new Set(users.map((u) => String(u?.id || "")).filter(Boolean))];

  const invoiceIds = new Set<string>();
  const keep = (inv: any) => {
    if (!inv?.id) return;
    if (!JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.has(String(inv.status || ""))) return;
    if (String(inv.invoice_kind || "") === "held") return;
    invoiceIds.add(String(inv.id));
  };
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const weekly = await readAll("Trade invoices", (a, b) =>
      client.from("trade_invoices")
        .select("id, status, invoice_kind")
        .in("user_id", chunk)
        .gte("week_end", from)
        .order("user_id", { ascending: true })
        .order("id", { ascending: true })
        .range(a, b));
    weekly.forEach(keep);
    const noWeek = await readAll("Trade invoices", (a, b) =>
      client.from("trade_invoices")
        .select("id, status, invoice_kind, submitted_at, created_at")
        .in("user_id", chunk)
        .is("week_end", null)
        .order("user_id", { ascending: true })
        .order("id", { ascending: true })
        .range(a, b));
    for (const inv of noWeek) {
      const at = Date.parse(String(inv?.submitted_at || inv?.created_at || ""));
      // An invoice with no readable date cannot be placed outside the window.
      if (Number.isNaN(at) || at >= fromInstant) keep(inv);
    }
  }

  const jobIds = new Set<string>();
  const ids = [...invoiceIds];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const lines = await readAll("Trade invoice lines", (a, b) =>
      client.from("trade_invoice_lines")
        .select("id, job_id, line_type")
        .in("trade_invoice_id", chunk)
        .order("id", { ascending: true })
        .range(a, b));
    for (const line of lines) {
      if (!line?.job_id || !countsAgainstWorkOrder(line.line_type)) continue;
      jobIds.add(String(line.job_id));
    }
    if (jobIds.size > OVERBILLED_MAX_JOBS) throw tooWide(days);
  }
  return { jobIds: [...jobIds].sort(), from };
}

/** A job billed in the window that the list cannot judge, and why. */
export type NoAgreedAmountJob = {
  job_id: string;
  job_number: string | null;
  /** none: no job work order. not_approved: one exists, not approved.
   *  no_amount: approved with no agreed labour. */
  work_order: "none" | "not_approved" | "no_amount";
};

/**
 * The job work order and job number of these jobs only. work_orders by job
 * (uq_work_orders_job_current: one job work order a job), jobs by primary key,
 * 100 ids at a time.
 */
async function readWorkOrdersForJobs(
  client: any,
  jobIds: readonly string[],
): Promise<{ capped: any[]; apart: NoAgreedAmountJob[] }> {
  const byJob = new Map<string, any>();
  const numbers = new Map<string, string | null>();
  for (let i = 0; i < jobIds.length; i += 100) {
    const chunk = jobIds.slice(i, i + 100);
    const orders = await readAll("Job work orders", (a, b) =>
      client.from("work_orders")
        .select("id, job_id, status, agreed_labour_ex")
        .eq("kind", "job")
        .in("job_id", chunk)
        .order("id", { ascending: true })
        .range(a, b));
    for (const r of orders) {
      if (!r?.id || !r?.job_id) continue;
      const jobId = String(r.job_id);
      const held = byJob.get(jobId);
      // One job work order a job; should two ever answer, an approved one wins.
      if (!held || (String(r.status) === "approved" && String(held.status) !== "approved")) {
        byJob.set(jobId, r);
      }
    }
    const { data, error } = await client.from("jobs")
      .select("id, job_number")
      .in("id", chunk);
    if (error || !Array.isArray(data)) throw unreadable("Job numbers");
    for (const j of data) {
      numbers.set(String(j?.id), j?.job_number == null ? null : String(j.job_number));
    }
  }
  const capped: any[] = [];
  const apart: NoAgreedAmountJob[] = [];
  for (const jobId of jobIds) {
    const r = byJob.get(jobId);
    const jobNumber = numbers.get(jobId) ?? null;
    if (r && String(r.status) === "approved" && r.agreed_labour_ex != null) {
      capped.push({
        id: String(r.id),
        job_id: jobId,
        status: r.status,
        agreed_labour_ex: r.agreed_labour_ex,
        job_number: jobNumber,
      });
      continue;
    }
    apart.push({
      job_id: jobId,
      job_number: jobNumber,
      work_order: !r ? "none" : String(r.status) === "approved" ? "no_amount" : "not_approved",
    });
  }
  apart.sort((a, b) =>
    String(a.job_number ?? a.job_id).localeCompare(String(b.job_number ?? b.job_id))
  );
  return { capped, apart };
}

export type OverbilledActionInput = {
  method: string;
  /** _opsApiCallerIsStaffOperator for this caller. */
  isStaff: boolean;
  /** The `days` query parameter as sent; absent is OVERBILLED_DEFAULT_DAYS. */
  days?: string | null;
  /** readHourlyLabourLimits, as list_work_orders kind=job passes it. */
  hourlyLimits?: (jobIds: string[]) => Promise<ReadonlyMap<string, number>>;
  /** The clock, for tests. */
  now?: Date;
};

/** The whole action: gate, read, shape. Throws OverbilledReadError. */
export async function listOverbilledJobWorkOrders(
  client: any,
  input: OverbilledActionInput,
): Promise<{
  ok: true;
  rule: "billed_over_agreed_labour";
  window_days: number;
  window_from: string;
  max_jobs: number;
  billed_jobs: number;
  checked_work_orders: number;
  count: number;
  total_gap_ex: number;
  jobs: OverbilledJob[];
  no_agreed_amount_count: number;
  no_agreed_amount: NoAgreedAmountJob[];
}> {
  if (String(input.method).toUpperCase() !== "GET") {
    throw new OverbilledReadError(
      405,
      "method_not_allowed",
      `${OVERBILLED_ACTION} is GET only`,
    );
  }
  if (!input.isStaff) {
    throw new OverbilledReadError(
      403,
      "operator_access_required",
      "An authorised operator session is required.",
    );
  }
  const days = overbilledWindowDays(input.days);
  const billed = await readJobsBilledInWindow(client, days, input.now ?? new Date());
  const { capped: rows, apart } = await readWorkOrdersForJobs(client, billed.jobIds);
  const cappedRows: any[] = [];
  for (let i = 0; i < rows.length; i += CAP_BATCH) {
    const batch = await withWorkOrderCaps(
      client,
      { work_orders: rows.slice(i, i + CAP_BATCH) },
      { hourlyLimits: input.hourlyLimits },
    );
    // A batch that could not be read refuses the whole answer: never a short list.
    if (batch.cap_read !== "ok") throw unreadable("Billed totals");
    cappedRows.push(...batch.work_orders);
  }
  const jobs = overbilledFromCappedListing(cappedRows);
  return {
    ok: true,
    rule: "billed_over_agreed_labour",
    window_days: days,
    window_from: billed.from,
    max_jobs: OVERBILLED_MAX_JOBS,
    billed_jobs: billed.jobIds.length,
    checked_work_orders: rows.length,
    count: jobs.length,
    total_gap_ex: fromCents(jobs.reduce((s, j) => s + cents(j.gap_ex), 0)),
    jobs,
    no_agreed_amount_count: apart.length,
    no_agreed_amount: apart,
  };
}
