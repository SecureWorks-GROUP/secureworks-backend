// deno-lint-ignore-file no-explicit-any
//
// The job card's H7 read (INT-10): where each supplier bill placed on this job
// counts its cost, read from Context's context_job_bill_outcomes
// (20261029170100), which reads CFO's cfo_bill_cost_outcomes (20261029170000)
// and nothing else.
//
// Context owns the record link and the placement it shows; CFO owns where the
// cost counts and every amount. So this read passes on no amount: an answer
// that carries a number, or a key that names money, is refused whole
// (`amount_present`), never trimmed. An answer on another contract version is
// refused (`contract_mismatch`): producer and consumer move together. A failed
// read is null with a code, never an empty list, and a code this reader does
// not know reads as unknown, never as "counts here".
//
// bill_state is CFO's, passed on as it stands (cfo-bill-cost-outcome-v1):
// unknown, voided, trade_mirror, held, not_job_related, overhead, not_counted,
// over_counted, counted_in_full, counted_in_part. over_counted is more counted
// (parts plus any overhead part) than the bill ex GST, such as 1200 on a 1000
// bill or two 700 placements on one: never read it as "in part". trade_mirror
// is a trade-app mirror bill a person placed on a job: where_counted reads
// trade_app and here.reason mirror_bill_person_placed, because its cost counts
// through the trade app's lines, never as this bill.

export const BILL_OUTCOME_CONTRACT_VERSION = "cfo-bill-cost-outcome-v1";
export const BILL_OUTCOME_SHAPE = "context-job-bill-outcomes-v1";

export const WHERE_COUNTED = [
  "here",
  "elsewhere",
  "here_and_elsewhere",
  "no_job",
  "trade_app",
  "held",
  "unknown",
] as const;
export type WhereCounted = typeof WHERE_COUNTED[number];

export const PLACEMENT_COUNTS = [
  "counted",
  "not_counted",
  "held",
  "unknown",
] as const;
export type PlacementCounts = typeof PLACEMENT_COUNTS[number];

/** The same money-key rule the SQL contract applies to the answer. */
export const MONEY_KEY = /(_ex|_inc|amount|total|price|cost|owing|paid)/i;

export type BillOutcomesRefusal =
  | "invalid_shape"
  | "contract_mismatch"
  | "amount_present";

export interface BillPlacement {
  job_id?: string | null;
  job_number?: string | null;
  xero_linked: boolean | null;
  placed_by: string | null;
  counts: PlacementCounts;
  reason: string | null;
  holding_job: boolean | null;
}

export const BILL_STATES = [
  "unknown",
  "voided",
  "trade_mirror",
  "held",
  "not_job_related",
  "overhead",
  "not_counted",
  "over_counted",
  "counted_in_full",
  "counted_in_part",
] as const;
export type BillState = typeof BILL_STATES[number];

export interface JobBill {
  xero_invoice_id: string;
  invoice_number: string | null;
  supplier: string | null;
  bill_status: string | null;
  bill_state: BillState;
  held_reason: string | null;
  change_hash: string | null;
  overhead_part: boolean | null;
  not_job_related_mark: boolean | null;
  // CFO's: a trade-app mirror bill (shown only where a person placed it).
  mirror_bill: boolean | null;
  where_counted: WhereCounted;
  here: BillPlacement | null;
  other_jobs: BillPlacement[];
}

export interface JobBillOutcomes {
  contract_version: string;
  shape: string;
  bills: JobBill[];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** The first place in the answer holding a number or a money key, or null. */
export function amountIn(value: unknown, path = "$"): string | null {
  if (typeof value === "number" || typeof value === "bigint") return path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = amountIn(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (MONEY_KEY.test(key)) return `${path}.${key}`;
      const hit = amountIn(inner, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

function placement(raw: any, withJob: boolean): BillPlacement {
  const counts = (PLACEMENT_COUNTS as readonly string[]).includes(raw?.counts)
    ? raw.counts as PlacementCounts
    : "unknown";
  return {
    ...(withJob
      ? { job_id: str(raw?.job_id), job_number: str(raw?.job_number) }
      : {}),
    xero_linked: bool(raw?.xero_linked),
    placed_by: str(raw?.placed_by),
    counts,
    reason: str(raw?.reason),
    holding_job: bool(raw?.holding_job),
  };
}

/**
 * Checks and normalises one answer from context_job_bill_outcomes. Refuses the
 * whole answer on another shape or contract version, or on any amount.
 */
export function validateJobBillOutcomes(
  data: unknown,
):
  | { ok: true; value: JobBillOutcomes }
  | { ok: false; code: BillOutcomesRefusal; detail?: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, code: "invalid_shape" };
  }
  const d = data as any;
  if (d.shape !== BILL_OUTCOME_SHAPE) {
    return { ok: false, code: "invalid_shape", detail: String(d.shape) };
  }
  if (
    d.contract_version !== BILL_OUTCOME_CONTRACT_VERSION ||
    d.contract_versions_agree !== true
  ) {
    return {
      ok: false,
      code: "contract_mismatch",
      detail: String(d.contract_version),
    };
  }
  const leak = amountIn(d);
  if (leak) return { ok: false, code: "amount_present", detail: leak };
  if (!Array.isArray(d.bills)) return { ok: false, code: "invalid_shape" };

  const bills: JobBill[] = [];
  for (const b of d.bills) {
    const id = str(b?.xero_invoice_id);
    if (!id) return { ok: false, code: "invalid_shape" };
    const here = b?.here && typeof b.here === "object"
      ? placement(b.here, false)
      : null;
    let where: WhereCounted =
      (WHERE_COUNTED as readonly string[]).includes(b?.where_counted)
        ? b.where_counted as WhereCounted
        : "unknown";
    // A bill with no placement on this job, or one whose placement here is
    // unknown, cannot say where it counts; "counts here" needs "counted" here.
    if (!here || here.counts === "unknown") where = "unknown";
    if (
      (where === "here" || where === "here_and_elsewhere") &&
      here?.counts !== "counted"
    ) where = "unknown";
    bills.push({
      xero_invoice_id: id,
      invoice_number: str(b?.invoice_number),
      supplier: str(b?.supplier),
      bill_status: str(b?.bill_status),
      // A state this reader does not know reads as unknown, never as counted.
      bill_state: (BILL_STATES as readonly string[]).includes(b?.bill_state)
        ? b.bill_state as BillState
        : "unknown",
      held_reason: str(b?.held_reason),
      change_hash: str(b?.change_hash),
      overhead_part: bool(b?.overhead_part),
      not_job_related_mark: bool(b?.not_job_related_mark),
      mirror_bill: bool(b?.mirror_bill),
      where_counted: where,
      here,
      other_jobs: Array.isArray(b?.other_jobs)
        ? b.other_jobs.map((o: any) => placement(o, true))
        : [],
    });
  }
  return {
    ok: true,
    value: {
      contract_version: d.contract_version,
      shape: d.shape,
      bills,
    },
  };
}
