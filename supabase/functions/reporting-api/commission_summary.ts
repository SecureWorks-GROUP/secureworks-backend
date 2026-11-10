// deno-lint-ignore-file no-explicit-any
// reporting-api commission_summary (SecureSale V2 commission card), RQ-19.b.
//
// A rep's commission on a job is the commission saved on the job's accepted
// quote: the scoper's percentage (fencing default 15%, editable) of that
// quote's own gross profit. Job Profit reads the same figure
// (v_job_profit.expected_commission_ex, from jobs.expected_costs or the
// accepted revision). It is never worked out here from the price and an
// assumed margin: a job with no saved commission reads commission null with
// a reason, and the total says it is incomplete. Earned trigger: deposit paid.

export const COMMISSION_SUMMARY_SOURCE = "v_job_profit.expected_commission_ex";

export const COMMISSION_PROFIT_COLUMNS = [
  "job_id",
  "quoted_ex",
  "expected_source",
  "expected_labour_ex",
  "expected_materials_ex",
  "expected_commission_ex",
  "holding_job",
].join(", ");

// Ids per v_job_profit read: keeps the PostgREST URL short.
const PROFIT_READ_CHUNK = 150;

export type CommissionJob = {
  id: string;
  type: string;
  client_name?: string | null;
  job_number?: string | null;
  pricing_json?: any;
};

export type CommissionProfitRow = {
  job_id: string;
  quoted_ex?: unknown;
  expected_source?: string | null;
  expected_labour_ex?: unknown;
  expected_materials_ex?: unknown;
  expected_commission_ex?: unknown;
  holding_job?: boolean | null;
};

function moneyOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// The quote value shown on the card (inc GST, display only; never a basis).
function quoteValueIncGst(j: CommissionJob): number {
  const p = j.pricing_json;
  if (!p || typeof p !== "object") return 0;
  return parseFloat(
    p.totalIncGST || p.totalExGST || p.total || p.grandTotal || p.subtotal || 0,
  ) || 0;
}

function unknownReason(row: CommissionProfitRow | undefined): string {
  if (!row) return "Job Profit has no row for this job";
  if (!row.expected_source) return "no accepted quote cost figures for this job";
  return "the accepted quote saved no commission";
}

/** The response body from the rep's earned jobs and their Job Profit rows. */
export function buildCommissionSummary(input: {
  period: string;
  periodStartIso: string;
  repUserId: string;
  jobs: CommissionJob[];
  earnedOn: Record<string, string>;
  profitRows: CommissionProfitRow[];
}) {
  const byJob = new Map<string, CommissionProfitRow>();
  for (const r of input.profitRows) {
    if (byJob.has(r.job_id)) {
      throw new Error("commission_summary: v_job_profit returned more than one row for a job");
    }
    byJob.set(r.job_id, r);
  }

  const breakdown: any[] = [];
  let earnedCents = 0;
  let unknownCount = 0;
  for (const j of input.jobs) {
    const earnedOn = input.earnedOn[j.id];
    if (!earnedOn) continue;
    const row = byJob.get(j.id);
    if (row?.holding_job === true) continue;
    const commission = moneyOrNull(row?.expected_commission_ex);
    if (commission === null) unknownCount++;
    else earnedCents += Math.round(commission * 100);
    breakdown.push({
      job_id: j.id,
      job_number: j.job_number ?? null,
      client_name: j.client_name ?? null,
      type: j.type,
      value: Math.round(quoteValueIncGst(j) * 100) / 100,
      quoted_ex: moneyOrNull(row?.quoted_ex),
      expected_labour_ex: moneyOrNull(row?.expected_labour_ex),
      expected_materials_ex: moneyOrNull(row?.expected_materials_ex),
      commission,
      commission_status: commission === null ? "unknown" : "known",
      commission_reason: commission === null ? unknownReason(row) : null,
      commission_source: commission === null ? null : (row?.expected_source ?? null),
      earned_on: earnedOn,
    });
  }

  breakdown.sort((a, b) => (a.earned_on < b.earned_on ? 1 : -1));

  return {
    period: input.period,
    period_start: input.periodStartIso,
    rep_user_id: input.repUserId,
    earned_total: earnedCents / 100,
    jobs_count: breakdown.length,
    commission_unknown_count: unknownCount,
    commission_complete: unknownCount === 0,
    breakdown,
    formula_snapshot: {
      commission_source: COMMISSION_SUMMARY_SOURCE,
      basis:
        "the commission saved on the accepted quote: the scoper's percentage of that quote's gross profit",
      earned_trigger: "deposit_paid",
      unknown_rule: "a job with no saved commission is not counted and is listed as unknown",
    },
  };
}

/** Reads the Job Profit rows for the given jobs; a failed read fails the answer. */
export async function readCommissionProfitRows(
  sb: any,
  orgId: string,
  ids: string[],
): Promise<CommissionProfitRow[]> {
  const out: CommissionProfitRow[] = [];
  for (let i = 0; i < ids.length; i += PROFIT_READ_CHUNK) {
    const { data, error } = await sb
      .from("v_job_profit")
      .select(COMMISSION_PROFIT_COLUMNS)
      .eq("org_id", orgId)
      .in("job_id", ids.slice(i, i + PROFIT_READ_CHUNK));
    if (error) {
      throw new Error(
        `commission_summary: v_job_profit read failed: ${error.message ?? String(error)}`,
      );
    }
    out.push(...((data || []) as CommissionProfitRow[]));
  }
  return out;
}
