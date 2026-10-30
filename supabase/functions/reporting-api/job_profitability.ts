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
//   - margin and margin_pct are the engine's, published only when margin_ok
//     and the engine gave both figures. Otherwise they are null, margin_status
//     is 'unknown' and margin_reason says why in words.
//   - bills is the costs placed on the job's own lines (actual_cost_ex), null
//     when nothing is placed: Unknown, not $0.
//   - committed_open_ex is null (committed_complete false) while any order is
//     unpriced or has an emailed invoice with no bill: a partial committed sum
//     is never shown as the whole.
//   - summary.avg_margin_pct is revenue-weighted over margin-known customer
//     jobs only (the job_profit_list?view=rollup basis). A holding job is in no
//     summary figure. A job missing from the engine is in no money sum either
//     (its invoiced is null) and is counted in jobs_not_in_engine.
//   - summary.total_bills is placed costs only; costs_complete is false when
//     any customer job's margin is unknown.
//
// Access: the action is not gated (AGENTS.md: only job_context and
// job_intelligence are). The fields added by CFO-01 that carry extra money
// (expected, committed, collected, holding job money) go only to staff (admin /
// owner / ops_manager) and server callers (detail 'full', reporting_staff_gate.ts
// reportingApiCallerSeesStaffDetail). Everyone else (the public SW_API_KEY, a
// trade JWT) gets detail 'basic': the earlier key set, with the Unknown-not-zero
// rule applied. Every caller gets margin_status, margin_reason and
// margin_reason_codes: they carry no money and say why a margin is Unknown.
// The earlier keys (invoiced, bills,
// margin, margin_pct, quote_value) were already readable by any signed-in user.
//
// Job selection (org, legacy, type, status, created from/to, limit, newest
// first) is the same `jobs` read as before, so filters mean what they meant.

export const JOB_PROFITABILITY_MONEY_SOURCE = "v_job_profit";

export type JobProfitabilityDetail = "full" | "basic";

// Ids per v_job_profit read: keeps the PostgREST URL short.
export const PROFIT_READ_CHUNK = 150;
// v_job_profit reads in flight at once (bounded, never one per chunk).
export const PROFIT_READ_CONCURRENCY = 3;

export const JOB_PROFIT_VIEW_COLUMNS = [
  "job_id",
  "org_id",
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
// sets margin_ok false in v_job_profit), in the order they are reported, plus
// this route's own two. Other codes (text_matched_lines, open_purchase_orders,
// draft_revenue, ...) are notes, not reasons the margin is unknown.
// materials_below_quote and variation_not_invoiced are Job Profit TP-13's
// (20261029160000): as shipped both hold the margin; each has a switch in
// job_profit_partial_cost_policy(), and the words match the story money book.
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
  materials_below_quote:
    "the materials bills placed are well under the materials in the quote, so a bill is probably still to come",
  no_labour_linked: "no labour linked",
  variation_not_invoiced:
    "an agreed variation is not covered by the invoices yet",
  not_in_job_profit_engine: "the job is not in the Job Profit engine",
  engine_reason_not_given:
    "the Job Profit engine published no margin and gave no reason",
};

// Row keys that only staff and server callers receive.
export const FULL_DETAIL_ROW_KEYS = [
  "expected_cost_ex",
  "expected_source",
  "committed_open_ex",
  "committed_complete",
  "ordered_not_billed_count",
  "invoice_emailed_count",
  "invoice_emailed_ex",
  "actual_cost_ex",
  "collected_ex",
  "draft_revenue_ex",
  "xero_project_expenses_ex",
  "quoted_source",
  "work_type",
  "revenue_flag",
  "cost_flag",
  "completeness",
] as const;

// Summary keys that only staff and server callers receive.
export const FULL_DETAIL_SUMMARY_KEYS = [
  "margin_known_invoiced",
  "margin_known_costs",
  "holding_jobs",
] as const;

const BASE_LABELS = {
  money_source:
    "Every money figure is from v_job_profit, the same engine the Job Profit screen reads.",
  margin:
    "margin and margin_pct are the engine's profit_ex and margin_pct (ex GST, direct costs, no overhead). Null when the engine cannot publish a margin; margin_status is then 'unknown' and margin_reason says why. Never 0 for an unknown.",
  bills:
    "Costs placed on the job's own lines so far, ex GST. Null when nothing is placed: Unknown, not $0. Placed costs only, not the job's full cost.",
  quote_value:
    "The sent or accepted quote's value, ex GST. Null when no quote was sent. Never the live price.",
  data_source:
    "Evidence found for the job: xero_projects (a Xero Project named with the job number), invoice_match (an invoice or a cost line on the job) or none. It never decides a money figure.",
  avg_margin_pct:
    "Revenue-weighted margin over margin-known customer jobs only. Null when no job's margin is known. Not the business's margin while any job is unknown: read jobs_margin_unknown and unknown_reasons beside it.",
  total_invoiced:
    "Invoiced, ex GST, over customer jobs the engine has a row for. A job missing from the engine is in no sum (jobs_not_in_engine).",
  total_bills:
    "Placed costs only, summed over customer jobs. costs_complete is false when any customer job's margin is unknown, so this is not the full cost.",
  total_margin:
    "Published profit of margin-known customer jobs only. Null when none is known. Never invoiced minus a partial cost.",
  holding_jobs:
    "Holding jobs (costs parked on a bucket card, not a customer's job) are in no summary figure.",
};

const FULL_LABELS = {
  ...BASE_LABELS,
  expected_committed_actual:
    "expected_cost_ex is fixed at the quote (null when none was fixed); committed_open_ex is priced open purchase orders, null with committed_complete false while any order is unpriced (ordered_not_billed_count) or has an emailed invoice with no bill (invoice_emailed_count); actual_cost_ex is placed costs (same as bills).",
};

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
  const words = codes.map((c) =>
    MARGIN_BLOCKING_REASONS[c] ?? c.replace(/_/g, " ")
  );
  return `Unknown: ${words.join("; ")}`;
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

/** One full-detail row: the job's identity from `jobs`, its money from v_job_profit. */
export function jobProfitabilityRow(
  job: Record<string, any>,
  profit: Record<string, unknown> | null,
): Record<string, unknown> {
  const profitEx = profit ? num(profit.profit_ex, "profit_ex") : null;
  const marginPct = profit ? num(profit.margin_pct, "margin_pct") : null;
  const known = profit?.margin_ok === true && profitEx !== null &&
    marginPct !== null;
  const placedEvents = profit
    ? num(profit.actual_cost_events, "actual_cost_events") ?? 0
    : 0;
  const placed = profit && placedEvents > 0
    ? num(profit.actual_cost_ex, "actual_cost_ex") ?? 0
    : null;
  let codes: string[] = [];
  if (!known) {
    codes = profit ? marginReasonCodes(profit) : ["not_in_job_profit_engine"];
    if (!codes.length) codes = ["engine_reason_not_given"];
  }
  const orderedUnpriced = profit
    ? num(profit.ordered_not_billed_count, "ordered_not_billed_count")
    : null;
  const emailedNoBill = profit
    ? num(profit.invoice_emailed_count, "invoice_emailed_count")
    : null;
  const committedComplete = !!profit && (orderedUnpriced ?? 0) === 0 &&
    (emailedNoBill ?? 0) === 0;

  return {
    id: job.id,
    job_number: job.job_number || (profit?.job_number as string) || null,
    client_name: job.client_name,
    type: job.type,
    status: job.status,
    quote_value: profit ? num(profit.quoted_ex, "quoted_ex") : null,
    invoiced: profit ? num(profit.invoiced_ex, "invoiced_ex") ?? 0 : null,
    bills: placed,
    margin: known ? profitEx : null,
    margin_pct: known ? marginPct : null,
    data_source: dataSourceOf(profit),
    // ── added (CFO-01 / R-22), every caller ──
    money_source: JOB_PROFITABILITY_MONEY_SOURCE,
    margin_status: known ? "known" : "unknown",
    margin_reason: known ? null : marginReasonText(codes),
    margin_reason_codes: codes,
    margin_ok: profit?.margin_ok === true,
    holding_job: profit?.holding_job === true,
    bills_basis: "placed_costs_only",
    // ── added (CFO-01 / R-22), staff and server callers only ──
    expected_cost_ex: profit
      ? num(profit.expected_cost_ex, "expected_cost_ex")
      : null,
    expected_source: profit?.expected_source ?? null,
    committed_open_ex: committedComplete
      ? num(profit!.committed_open_ex, "committed_open_ex")
      : null,
    committed_complete: committedComplete,
    ordered_not_billed_count: orderedUnpriced,
    invoice_emailed_count: emailedNoBill,
    invoice_emailed_ex: profit
      ? num(profit.invoice_emailed_ex, "invoice_emailed_ex")
      : null,
    actual_cost_ex: placed,
    collected_ex: profit ? num(profit.collected_ex, "collected_ex") : null,
    draft_revenue_ex: profit
      ? num(profit.draft_revenue_ex, "draft_revenue_ex")
      : null,
    xero_project_expenses_ex: profit
      ? num(profit.xero_project_expenses_ex, "xero_project_expenses_ex")
      : null,
    quoted_source: profit?.quoted_source ?? null,
    work_type: profit?.work_type ?? null,
    revenue_flag: profit?.revenue_flag ?? null,
    cost_flag: profit?.cost_flag ?? null,
    completeness: Array.isArray(profit?.completeness)
      ? profit!.completeness
      : [],
  };
}

function withoutKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

/** The response body from the selected jobs and their v_job_profit rows. */
export function buildJobProfitability(
  jobs: Record<string, any>[],
  profitRows: Record<string, unknown>[],
  detail: JobProfitabilityDetail = "basic",
): Record<string, unknown> {
  const byJob = new Map<string, Record<string, unknown>>();
  for (const p of profitRows) {
    const id = String(p.job_id ?? "");
    if (!id) continue;
    if (byJob.has(id)) {
      // As ops-api job_profit: a second engine row for one job is a fault,
      // never a pick.
      throw new Error(
        "job_profitability: v_job_profit returned more than one row for a job",
      );
    }
    byJob.set(id, p);
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
  let notInEngine = 0;
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
    // A job missing from the engine has invoiced and bills null: in no sum.
    if (r.invoiced === null) notInEngine += 1;
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

  const summary: Record<string, unknown> = {
    total_jobs: rows.length,
    total_invoiced: fromCents(invoicedC),
    total_bills: fromCents(placedC),
    total_margin: known > 0 ? fromCents(knownProfitC) : null,
    avg_margin_pct: avgMargin,
    data_sources: dataSourceCounts,
    xero_projects_matched:
      rows.filter((r) => r.data_source === "xero_projects").length,
    // ── added (CFO-01 / R-22), every caller ──
    money_source: JOB_PROFITABILITY_MONEY_SOURCE,
    detail,
    customer_jobs: known + unknown,
    jobs_margin_known: known,
    jobs_margin_unknown: unknown,
    jobs_not_in_engine: notInEngine,
    unknown_reasons: unknownReasons,
    avg_margin_basis: "revenue_weighted_over_margin_known_customer_jobs",
    total_bills_basis: "placed_costs_only",
    costs_complete: unknown === 0,
    holding_jobs_excluded: holding.jobs,
    // ── added (CFO-01 / R-22), staff and server callers only ──
    margin_known_invoiced: known > 0 ? fromCents(knownInvoicedC) : null,
    margin_known_costs: known > 0 ? fromCents(knownCostC) : null,
    holding_jobs: holding,
  };

  if (detail === "full") {
    return { jobs: rows, summary, labels: FULL_LABELS };
  }
  return {
    jobs: rows.map((r) => withoutKeys(r, FULL_DETAIL_ROW_KEYS)),
    summary: withoutKeys(summary, FULL_DETAIL_SUMMARY_KEYS),
    labels: BASE_LABELS,
  };
}

/** `limit`: whole number 1..5000, default 50 (0 and non-numbers too, as before). */
export function jobProfitabilityLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n === 0) return 50;
  return Math.min(Math.max(n, 1), 5000);
}

async function readProfitChunks(
  sb: any,
  orgId: string,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += PROFIT_READ_CHUNK) {
    chunks.push(ids.slice(i, i + PROFIT_READ_CHUNK));
  }
  const results: Record<string, unknown>[][] = new Array(chunks.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < chunks.length) {
      const at = next++;
      const { data, error } = await sb
        .from("v_job_profit")
        .select(JOB_PROFIT_VIEW_COLUMNS)
        .eq("org_id", orgId)
        .in("job_id", chunks[at]);
      if (error) {
        failed = true;
        throw new Error(
          `job_profitability: v_job_profit read failed: ${
            error.message ?? String(error)
          }`,
        );
      }
      results[at] = data || [];
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PROFIT_READ_CONCURRENCY, chunks.length) },
      worker,
    ),
  );
  return results.flat();
}

/** Reads the selected jobs, then their v_job_profit rows, and builds the body. */
export async function jobProfitabilityAction(
  sb: any,
  params: URLSearchParams,
  orgId: string,
  detail: JobProfitabilityDetail = "basic",
): Promise<Record<string, unknown>> {
  const dateFrom = params.get("from") || null;
  const dateTo = params.get("to") || null;
  const jobType = params.get("type") || null;
  const status = params.get("status") || null;
  const limit = jobProfitabilityLimit(params.get("limit"));

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
  const profitRows = ids.length ? await readProfitChunks(sb, orgId, ids) : [];

  return buildJobProfitability(jobList, profitRows, detail);
}
