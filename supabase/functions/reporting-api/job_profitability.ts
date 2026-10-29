// deno-lint-ignore-file no-explicit-any
// reporting-api `job_profitability` (CFO-01 / R-22: each job shows expected,
// committed and actual separately; an unknown is a word with a reason, never
// $0).
//
// Callers: Jarvis `sw_job_profitability` / `sw_analyse_profitability`, the
// ops-ai and agent-runner `get_job_profitability` tools, and the
// secureworks-ux Job P&L tab.
//
// Every money figure here comes from v_job_profit, the engine the Job Profit
// screen reads (ops-api job_profit / job_profit_list). Nothing is computed
// from Xero Projects totals or contact-matched bills any more:
//   - margin and margin_pct are the engine's, published only when margin_ok.
//     Otherwise they are null, margin_status is 'unknown' and margin_reason
//     says why in words (from completeness / cost_flag / revenue_flag).
//   - bills is the costs placed on the job's own lines (the engine's
//     actual_cost_ex). It is null when nothing is placed: no placed cost is
//     Unknown, not $0.
//   - summary.avg_margin_pct is revenue-weighted over margin-known customer
//     jobs only (the same basis as job_profit_list?view=rollup). A holding job
//     (costs parked on a bucket card) is in no summary figure; it is reported
//     on its own under summary.holding_jobs.
//   - summary.total_bills is placed costs only; costs_complete is false when
//     any customer job's margin is unknown. total_margin is the published
//     profit of margin-known jobs, never invoiced minus a partial cost.
//
// Job selection (org, legacy, type, status, created from/to, limit, newest
// first) is the same `jobs` read as before, so filters mean what they meant.
// Every earlier output key is kept; data_source is kept as evidence presence
// only and money_source names where the money came from.

export const JOB_PROFITABILITY_MONEY_SOURCE = "v_job_profit";

// Ids per v_job_profit read: keeps the PostgREST URL short.
export const PROFIT_READ_CHUNK = 150;

export const JOB_PROFIT_VIEW_COLUMNS = [
  "job_id",
  "job_number",
  "work_type",
  "quoted_ex",
  "quoted_source",
  "expected_source",
  "expected_cost_ex",
  "committed_open_ex",
  "ordered_not_billed_count",
  "invoice_emailed_count",
  "invoice_emailed_ex",
  "actual_cost_ex",
  "actual_cost_events",
  "xero_project_expenses_ex",
  "xero_project_count",
  "invoiced_ex",
  "draft_revenue_ex",
  "collected_ex",
  "invoice_count",
  "profit_ex",
  "margin_pct",
  "revenue_flag",
  "cost_flag",
  "completeness",
  "margin_ok",
  "holding_job",
].join(", ");

// The completeness codes that stop the engine publishing a margin (each one
// sets margin_ok false in v_job_profit), in the order they are reported.
// Other codes (text_matched_lines, open_purchase_orders, draft_revenue, ...)
// are notes, not reasons the margin is unknown.
export const MARGIN_BLOCKING_REASONS: Record<string, string> = {
  missing_client_invoice: "no client invoice yet",
  no_cost_linked: "no cost linked to the job yet",
  installer_bill_unconfirmed:
    "an installer bill on the job is not confirmed by a person",
  xero_project_exceeds_line_costs:
    "the Xero Project has more expenses on record than the costs linked to the job",
  incomplete_invoice_lines: "a trade invoice on the job has incomplete lines",
  unclassified_lines: "some cost lines are unclassified",
  materials_not_linked: "materials are owed but none is linked",
  no_labour_linked: "no labour linked",
  not_in_job_profit_engine: "the job is not in the Job Profit engine",
};

export const JOB_PROFITABILITY_LABELS = {
  money_source:
    "Every money figure is from v_job_profit, the same engine the Job Profit screen reads.",
  margin:
    "margin and margin_pct are the engine's profit_ex and margin_pct (ex GST, direct costs, no overhead). Null when the engine cannot publish a margin; margin_status is then 'unknown' and margin_reason says why. Never 0 for an unknown.",
  bills:
    "Costs placed on the job's own lines so far (actual_cost_ex), ex GST. Null when nothing is placed: Unknown, not $0. Placed costs only, not the job's full cost.",
  quote_value:
    "The sent or accepted quote's value, ex GST (quoted_ex). Null when no quote was sent. Never the live price.",
  expected_committed_actual:
    "expected_cost_ex is fixed at the quote (null when none was fixed); committed_open_ex is priced open purchase orders (unpriced orders are counted in ordered_not_billed_count, never $0); actual_cost_ex is placed costs (same as bills).",
  data_source:
    "Evidence found for the job: xero_projects (a Xero Project named with the job number), invoice_match (an invoice or a cost line on the job) or none. It never decides a money figure.",
  avg_margin_pct:
    "Revenue-weighted margin over margin-known customer jobs only (profit over invoiced of those jobs). Null when no job's margin is known. Not the business's margin while any job is unknown: read jobs_margin_unknown and unknown_reasons beside it.",
  total_bills:
    "Placed costs only, summed over customer jobs. costs_complete is false when any customer job's margin is unknown, so this is not the full cost.",
  total_margin:
    "Published profit of margin-known customer jobs only. Null when none is known. Never invoiced minus a partial cost.",
  holding_jobs:
    "Holding jobs (costs parked on a bucket card, not a customer's job) are in no summary figure; they are reported on their own here.",
} as const;

type Num = number | null;

function num(value: unknown, field: string): Num {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) {
    throw new Error(`v_job_profit.${field} is not a number`);
  }
  return n;
}

function cents(n: Num): number {
  return n === null ? 0 : Math.round(n * 100);
}

function fromCents(c: number): number {
  return c / 100;
}

/** The blocking reason codes for a row the engine did not publish a margin for. */
export function marginReasonCodes(profit: Record<string, unknown>): string[] {
  const completeness = Array.isArray(profit.completeness)
    ? profit.completeness.map(String)
    : [];
  const codes = Object.keys(MARGIN_BLOCKING_REASONS).filter((c) =>
    completeness.includes(c)
  );
  if (codes.length) return codes;
  // completeness is the full list; fall back to the single flags if a row
  // ever arrives without it.
  const fallback: string[] = [];
  const rf = String(profit.revenue_flag ?? "");
  const cf = String(profit.cost_flag ?? "");
  if (rf && rf !== "ok") fallback.push(rf);
  if (cf && cf !== "ok" && cf !== "text_matched_lines") fallback.push(cf);
  return fallback;
}

export function marginReasonText(codes: string[]): string {
  if (!codes.length) {
    return "Unknown: the Job Profit engine did not publish a margin for this job";
  }
  const words = codes.map((c) =>
    MARGIN_BLOCKING_REASONS[c] ?? c.replace(/_/g, " ")
  );
  const text = words.join("; ");
  return `Unknown: ${text}`;
}

function dataSourceOf(profit: Record<string, unknown> | null): string {
  if (!profit) return "none";
  if ((num(profit.xero_project_count, "xero_project_count") ?? 0) > 0) {
    return "xero_projects";
  }
  const evidence = (num(profit.invoice_count, "invoice_count") ?? 0) > 0 ||
    (num(profit.actual_cost_events, "actual_cost_events") ?? 0) > 0 ||
    (num(profit.draft_revenue_ex, "draft_revenue_ex") ?? 0) > 0;
  return evidence ? "invoice_match" : "none";
}

/** One output row: the job's identity from `jobs`, its money from v_job_profit. */
export function jobProfitabilityRow(
  job: Record<string, any>,
  profit: Record<string, unknown> | null,
): Record<string, unknown> {
  const marginOk = profit?.margin_ok === true;
  const placedEvents = profit
    ? num(profit.actual_cost_events, "actual_cost_events") ?? 0
    : 0;
  const placed = profit && placedEvents > 0
    ? num(profit.actual_cost_ex, "actual_cost_ex") ?? 0
    : null;
  const codes = marginOk
    ? []
    : profit
    ? marginReasonCodes(profit)
    : ["not_in_job_profit_engine"];

  return {
    id: job.id,
    job_number: job.job_number || (profit?.job_number as string) || null,
    client_name: job.client_name,
    type: job.type,
    status: job.status,
    quote_value: profit ? num(profit.quoted_ex, "quoted_ex") : null,
    invoiced: profit ? num(profit.invoiced_ex, "invoiced_ex") ?? 0 : null,
    bills: placed,
    margin: marginOk ? num(profit!.profit_ex, "profit_ex") : null,
    margin_pct: marginOk ? num(profit!.margin_pct, "margin_pct") : null,
    data_source: dataSourceOf(profit),
    // ── added (CFO-01 / R-22) ──
    money_source: JOB_PROFITABILITY_MONEY_SOURCE,
    margin_status: marginOk ? "known" : "unknown",
    margin_reason: marginOk ? null : marginReasonText(codes),
    margin_reason_codes: codes,
    margin_ok: marginOk,
    holding_job: profit?.holding_job === true,
    work_type: profit?.work_type ?? null,
    quoted_source: profit?.quoted_source ?? null,
    expected_cost_ex: profit
      ? num(profit.expected_cost_ex, "expected_cost_ex")
      : null,
    expected_source: profit?.expected_source ?? null,
    committed_open_ex: profit
      ? num(profit.committed_open_ex, "committed_open_ex")
      : null,
    ordered_not_billed_count: profit
      ? num(profit.ordered_not_billed_count, "ordered_not_billed_count")
      : null,
    invoice_emailed_count: profit
      ? num(profit.invoice_emailed_count, "invoice_emailed_count")
      : null,
    invoice_emailed_ex: profit
      ? num(profit.invoice_emailed_ex, "invoice_emailed_ex")
      : null,
    actual_cost_ex: placed,
    bills_basis: "placed_costs_only",
    collected_ex: profit ? num(profit.collected_ex, "collected_ex") : null,
    draft_revenue_ex: profit
      ? num(profit.draft_revenue_ex, "draft_revenue_ex")
      : null,
    xero_project_expenses_ex: profit
      ? num(profit.xero_project_expenses_ex, "xero_project_expenses_ex")
      : null,
    revenue_flag: profit?.revenue_flag ?? null,
    cost_flag: profit?.cost_flag ?? null,
    completeness: Array.isArray(profit?.completeness)
      ? profit!.completeness
      : [],
  };
}

/** The response body from the selected jobs and their v_job_profit rows. */
export function buildJobProfitability(
  jobs: Record<string, any>[],
  profitRows: Record<string, unknown>[],
): Record<string, unknown> {
  const byJob = new Map<string, Record<string, unknown>>();
  for (const p of profitRows) {
    const id = String(p.job_id ?? "");
    if (id && !byJob.has(id)) byJob.set(id, p);
  }
  const rows = jobs.map((job) =>
    jobProfitabilityRow(job, byJob.get(String(job.id)) ?? null)
  );

  let invoicedC = 0;
  let placedC = 0;
  let knownProfitC = 0;
  let knownInvoicedC = 0;
  let knownCostC = 0;
  let known = 0;
  let unknown = 0;
  const unknownReasons: Record<string, number> = {};
  const holding = {
    jobs: 0,
    invoiced: 0,
    placed_costs: 0,
    job_numbers: [] as unknown[],
  };
  let holdingInvoicedC = 0;
  let holdingPlacedC = 0;

  for (const r of rows) {
    if (r.holding_job === true) {
      holding.jobs += 1;
      holdingInvoicedC += cents(r.invoiced as Num);
      holdingPlacedC += cents(r.bills as Num);
      holding.job_numbers.push(r.job_number ?? r.id);
      continue;
    }
    invoicedC += cents(r.invoiced as Num);
    placedC += cents(r.bills as Num);
    if (r.margin_status === "known") {
      known += 1;
      knownProfitC += cents(r.margin as Num);
      knownInvoicedC += cents(r.invoiced as Num);
      knownCostC += cents(r.bills as Num);
    } else {
      unknown += 1;
      for (const code of r.margin_reason_codes as string[]) {
        unknownReasons[code] = (unknownReasons[code] || 0) + 1;
      }
    }
  }
  holding.invoiced = fromCents(holdingInvoicedC);
  holding.placed_costs = fromCents(holdingPlacedC);

  const avgMargin = known > 0 && knownInvoicedC > 0
    ? Math.round((knownProfitC / knownInvoicedC) * 1000) / 10
    : null;

  const dataSourceCounts = rows.reduce((acc: Record<string, number>, r) => {
    const k = String(r.data_source);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return {
    jobs: rows,
    summary: {
      total_jobs: rows.length,
      total_invoiced: fromCents(invoicedC),
      total_bills: fromCents(placedC),
      total_margin: known > 0 ? fromCents(knownProfitC) : null,
      avg_margin_pct: avgMargin,
      data_sources: dataSourceCounts,
      xero_projects_matched:
        rows.filter((r) => r.data_source === "xero_projects").length,
      // ── added (CFO-01 / R-22) ──
      money_source: JOB_PROFITABILITY_MONEY_SOURCE,
      customer_jobs: known + unknown,
      jobs_margin_known: known,
      jobs_margin_unknown: unknown,
      unknown_reasons: unknownReasons,
      avg_margin_basis: "revenue_weighted_over_margin_known_customer_jobs",
      margin_known_invoiced: known > 0 ? fromCents(knownInvoicedC) : null,
      margin_known_costs: known > 0 ? fromCents(knownCostC) : null,
      total_bills_basis: "placed_costs_only",
      costs_complete: unknown === 0,
      holding_jobs: holding,
    },
    labels: JOB_PROFITABILITY_LABELS,
  };
}

/** Reads the selected jobs, then their v_job_profit rows, and builds the body. */
export async function jobProfitabilityAction(
  sb: any,
  params: URLSearchParams,
  orgId: string,
): Promise<Record<string, unknown>> {
  const dateFrom = params.get("from") || null;
  const dateTo = params.get("to") || null;
  const jobType = params.get("type") || null;
  const status = params.get("status") || null;
  const limit = Math.min(parseInt(params.get("limit") || "50", 10) || 50, 5000);

  let query = sb
    .from("jobs")
    .select("id, type, status, client_name, created_at, job_number")
    .eq("org_id", orgId)
    .eq("legacy", false)
    .order("created_at", { ascending: false });

  if (jobType) query = query.eq("type", jobType);
  if (status) query = query.eq("status", status);
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo) query = query.lte("created_at", dateTo);
  query = query.limit(limit);

  const { data: jobs, error: jobErr } = await query;
  if (jobErr) throw jobErr;
  const jobList: Record<string, any>[] = jobs || [];

  // A failed read fails the whole answer: a partial money answer is never returned.
  const ids = jobList.map((j) => j.id).filter(Boolean);
  const profitRows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += PROFIT_READ_CHUNK) {
    const chunk = ids.slice(i, i + PROFIT_READ_CHUNK);
    const { data, error } = await sb
      .from("v_job_profit")
      .select(JOB_PROFIT_VIEW_COLUMNS)
      .eq("org_id", orgId)
      .in("job_id", chunk);
    if (error) {
      throw new Error(
        `job_profitability: v_job_profit read failed: ${
          error.message ?? String(error)
        }`,
      );
    }
    profitRows.push(...(data || []));
  }

  return buildJobProfitability(jobList, profitRows);
}
