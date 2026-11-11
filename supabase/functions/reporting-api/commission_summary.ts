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
//
// Job Profit's estimate can also come from a sent quote or a sealed scope
// that was never accepted; those are not the rep's commission. And the
// quote snapshot behind an accepted revision writes 0 when the quote saved
// no commission, so that source counts only when the same accepted revision's
// saved pricing holds the figure the snapshot was built from.

export const COMMISSION_SUMMARY_SOURCE = "v_job_profit.expected_commission_ex";

export const COMMISSION_PROFIT_COLUMNS = [
  "job_id",
  "quoted_ex",
  "expected_source",
  "expected_labour_ex",
  "expected_materials_ex",
  "expected_commission_ex",
].join(", ");

// Job Profit sources that are the customer's accepted quote.
export const ACCEPTED_COMMISSION_SOURCES = ["frozen_at_acceptance", "accepted_quote_revision"];

// The newest accepted revision's saved commission (same pick as Job Profit's
// accepted_rev: newest acceptance, then newest version), projected only.
const ACCEPTED_REVISION_COLUMNS = [
  "job_id",
  "version",
  "raw_commission:pricing_snapshot_json->raw->commissionCostEstimate",
  "raw_internal_commission:pricing_snapshot_json->raw->internal->commission",
  "snapshot_commission:internal_cost_snapshot_json->cost_estimates->subcontract_commission_total",
  "job_documents!inner(accepted_at)",
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
};

/** The accepted revision Job Profit read, with what its saved pricing held. */
export type AcceptedRevisionCommission = {
  job_id: string;
  raw_commission?: unknown;
  raw_internal_commission?: unknown;
  snapshot_commission?: unknown;
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

// The figure the quote adapter put in the snapshot, from the saved pricing:
// the fence adapter reads internal.commission first, every other adapter
// commissionCostEstimate. Absent there means the snapshot's 0 was filled in.
function savedRevisionCommission(type: string, ev: AcceptedRevisionCommission): number | null {
  const v = type === "fencing"
    ? (ev.raw_internal_commission ?? ev.raw_commission)
    : ev.raw_commission;
  return moneyOrNull(v);
}

/** The rep's commission on a job, or why it is not known. */
function acceptedCommission(
  type: string,
  row: CommissionProfitRow | undefined,
  ev: AcceptedRevisionCommission | undefined,
): { amount: number; reason: null } | { amount: null; reason: string } {
  if (!row) return { amount: null, reason: "Job Profit has no row for this job" };
  if (!row.expected_source) return { amount: null, reason: "no accepted quote cost figures for this job" };
  if (!ACCEPTED_COMMISSION_SOURCES.includes(row.expected_source)) {
    return { amount: null, reason: "the cost figures are from a quote that was not accepted" };
  }
  const amount = moneyOrNull(row.expected_commission_ex);
  if (amount === null) return { amount: null, reason: "the accepted quote saved no commission" };
  if (row.expected_source === "accepted_quote_revision") {
    const saved = ev ? savedRevisionCommission(type, ev) : null;
    if (saved === null) return { amount: null, reason: "the accepted quote saved no commission" };
    if (saved !== amount || moneyOrNull(ev?.snapshot_commission) !== amount) {
      return { amount: null, reason: "the accepted quote's saved commission does not match its cost figures" };
    }
  }
  return { amount, reason: null };
}

/** The response body from the rep's earned jobs and their Job Profit rows. */
export function buildCommissionSummary(input: {
  period: string;
  periodStartIso: string;
  repUserId: string;
  jobs: CommissionJob[];
  earnedOn: Record<string, string>;
  profitRows: CommissionProfitRow[];
  acceptedRevisions?: AcceptedRevisionCommission[];
}) {
  const byJob = new Map<string, CommissionProfitRow>();
  for (const r of input.profitRows) {
    if (byJob.has(r.job_id)) {
      throw new Error("commission_summary: v_job_profit returned more than one row for a job");
    }
    byJob.set(r.job_id, r);
  }
  const revByJob = new Map<string, AcceptedRevisionCommission>();
  for (const r of input.acceptedRevisions ?? []) {
    if (revByJob.has(r.job_id)) {
      throw new Error("commission_summary: more than one accepted revision for a job");
    }
    revByJob.set(r.job_id, r);
  }

  const breakdown: any[] = [];
  let earnedCents = 0;
  let unknownCount = 0;
  for (const j of input.jobs) {
    const earnedOn = input.earnedOn[j.id];
    if (!earnedOn) continue;
    const value = quoteValueIncGst(j);
    if (value <= 0) continue;
    const row = byJob.get(j.id);
    const { amount: commission, reason } = acceptedCommission(j.type, row, revByJob.get(j.id));
    if (commission === null) unknownCount++;
    else earnedCents += Math.round(commission * 100);
    breakdown.push({
      job_id: j.id,
      job_number: j.job_number ?? null,
      client_name: j.client_name ?? null,
      type: j.type,
      value: Math.round(value * 100) / 100,
      quoted_ex: moneyOrNull(row?.quoted_ex),
      expected_labour_ex: moneyOrNull(row?.expected_labour_ex),
      expected_materials_ex: moneyOrNull(row?.expected_materials_ex),
      commission,
      commission_status: commission === null ? "unknown" : "known",
      commission_reason: reason,
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
      unknown_rule:
        "a job with no commission saved on its accepted quote is not counted and is listed as unknown",
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

/**
 * The newest accepted revision of each job, for the jobs whose Job Profit
 * commission comes from it. A failed read fails the answer.
 */
export async function readAcceptedRevisionCommissions(
  sb: any,
  ids: string[],
): Promise<AcceptedRevisionCommission[]> {
  const newest = new Map<string, { at: string; version: number; row: AcceptedRevisionCommission }>();
  for (let i = 0; i < ids.length; i += PROFIT_READ_CHUNK) {
    const { data, error } = await sb
      .from("quote_revisions")
      .select(ACCEPTED_REVISION_COLUMNS)
      .in("job_id", ids.slice(i, i + PROFIT_READ_CHUNK))
      .not("job_documents.accepted_at", "is", null);
    if (error) {
      throw new Error(
        `commission_summary: accepted quote read failed: ${error.message ?? String(error)}`,
      );
    }
    for (const r of (data || []) as any[]) {
      const at = String(r.job_documents?.accepted_at ?? "");
      if (!at) continue;
      const version = Number(r.version) || 0;
      const t = Date.parse(at);
      const cur = newest.get(r.job_id);
      const curT = cur ? Date.parse(cur.at) : -Infinity;
      if (!cur || t > curT || (t === curT && version > cur.version)) {
        newest.set(r.job_id, {
          at,
          version,
          row: {
            job_id: r.job_id,
            raw_commission: r.raw_commission,
            raw_internal_commission: r.raw_internal_commission,
            snapshot_commission: r.snapshot_commission,
          },
        });
      }
    }
  }
  return Array.from(newest.values(), (v) => v.row);
}
