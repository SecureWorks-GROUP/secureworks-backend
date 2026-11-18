// Jobs billed over their agreed labour (follow-up 49 item 9(d)): the office's
// first overcharge review. A read only: it writes nothing, sends nothing and
// needs no switch.
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

import { withWorkOrderCaps } from "./work_order_total_cap.ts";

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

/**
 * Every approved job work order with an agreed labour figure, with its job
 * number. work_orders by kind (uq_work_orders_job_current / idx_work_orders_kind),
 * then jobs by primary key, 100 ids at a time.
 */
async function readApprovedJobWorkOrders(client: any): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0;; offset += 1000) {
    const { data, error } = await client.from("work_orders")
      .select("id, job_id, status, agreed_labour_ex")
      .eq("kind", "job")
      .eq("status", "approved")
      .not("agreed_labour_ex", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error || !Array.isArray(data)) throw unreadable("Job work orders");
    for (const r of data) {
      if (!r?.id || !r?.job_id) continue;
      rows.push({
        id: String(r.id),
        job_id: String(r.job_id),
        status: r.status,
        agreed_labour_ex: r.agreed_labour_ex,
        job_number: null as string | null,
      });
    }
    if (data.length < 1000) break;
  }
  const jobIds = [...new Set(rows.map((r) => r.job_id))];
  const numbers = new Map<string, string | null>();
  for (let i = 0; i < jobIds.length; i += 100) {
    const { data, error } = await client.from("jobs")
      .select("id, job_number")
      .in("id", jobIds.slice(i, i + 100));
    if (error || !Array.isArray(data)) throw unreadable("Job numbers");
    for (const j of data) {
      numbers.set(String(j?.id), j?.job_number == null ? null : String(j.job_number));
    }
  }
  for (const r of rows) r.job_number = numbers.get(r.job_id) ?? null;
  return rows;
}

export type OverbilledActionInput = {
  method: string;
  /** _opsApiCallerIsStaffOperator for this caller. */
  isStaff: boolean;
  /** readHourlyLabourLimits, as list_work_orders kind=job passes it. */
  hourlyLimits?: (jobIds: string[]) => Promise<ReadonlyMap<string, number>>;
};

/** The whole action: gate, read, shape. Throws OverbilledReadError. */
export async function listOverbilledJobWorkOrders(
  client: any,
  input: OverbilledActionInput,
): Promise<{
  ok: true;
  rule: "billed_over_agreed_labour";
  checked_work_orders: number;
  count: number;
  total_gap_ex: number;
  jobs: OverbilledJob[];
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
  const rows = await readApprovedJobWorkOrders(client);
  const capped = await withWorkOrderCaps(client, { work_orders: rows }, {
    hourlyLimits: input.hourlyLimits,
  });
  if (capped.cap_read !== "ok") {
    throw unreadable("Billed totals");
  }
  const jobs = overbilledFromCappedListing(capped.work_orders);
  return {
    ok: true,
    rule: "billed_over_agreed_labour",
    checked_work_orders: rows.length,
    count: jobs.length,
    total_gap_ex: fromCents(jobs.reduce((s, j) => s + cents(j.gap_ex), 0)),
    jobs,
  };
}
