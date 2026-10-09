// Company, work-type and month totals for job_profit_list?view=rollup.
//
// Reads EVERY v_job_profit row matching the list's validated filters (limit and
// offset never bound the aggregate), page by page, and sums them here in integer
// cents. A failed page fails the whole answer: a partial total is never returned.
//
// Profit and margin come only from rows the engine already published
// (profit_ex not null). profit_ex_unsuppressed is never read, and Xero Project
// figures are never added to line-level costs: actual_cost_ex is the engine's
// chosen basis and is summed as it stands.
//
// by_month groups jobs by the date_field that filtered them (created Perth day
// or first invoice date). It is a job cohort, not an accrual P&L period.

export type JobProfitRollupFilters = {
  ok: true;
  types: string[];
  statuses: string[];
  from: string | null;
  to: string | null;
  dateField: "created" | "invoiced";
  limit: number;
  offset: number;
};

export type JobProfitRollupResult = { status: number; body: Record<string, unknown> };

const ROLLUP_PAGE_SIZE = 1000;
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;

const ROLLUP_COLUMNS = [
  "job_id",
  "work_type",
  "created_at",
  "first_invoice_date",
  "invoiced_ex",
  "collected_ex",
  "quoted_ex",
  "expected_cost_ex",
  "actual_cost_ex",
  "profit_ex",
  "cost_basis",
  "revenue_verified_paid",
].join(", ");

type Bucket = {
  jobs: number;
  jobs_with_margin: number;
  invoiced: bigint;
  collected: bigint;
  quoted: bigint | null;
  expected: bigint | null;
  actual: bigint;
  published_revenue: bigint;
  published_cost: bigint;
  profit: bigint;
  inferred_jobs: number;
  revenue_verified_paid_jobs: number;
};

function emptyBucket(): Bucket {
  return {
    jobs: 0,
    jobs_with_margin: 0,
    invoiced: 0n,
    collected: 0n,
    quoted: null,
    expected: null,
    actual: 0n,
    published_revenue: 0n,
    published_cost: 0n,
    profit: 0n,
    inferred_jobs: 0,
    revenue_verified_paid_jobs: 0,
  };
}

// numeric arrives from PostgREST as a number or a string; null stays null.
function toCents(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) throw new Error(`v_job_profit.${field} is not a number`);
  return BigInt(Math.round(n * 100));
}

function centsToNumber(cents: bigint | null): number | null {
  return cents === null ? null : Number(cents) / 100;
}

function addRow(bucket: Bucket, row: Record<string, unknown>) {
  const invoiced = toCents(row.invoiced_ex, "invoiced_ex");
  const collected = toCents(row.collected_ex, "collected_ex");
  const quoted = toCents(row.quoted_ex, "quoted_ex");
  const expected = toCents(row.expected_cost_ex, "expected_cost_ex");
  const actual = toCents(row.actual_cost_ex, "actual_cost_ex");
  const profit = toCents(row.profit_ex, "profit_ex");

  bucket.jobs += 1;
  bucket.invoiced += invoiced ?? 0n;
  bucket.collected += collected ?? 0n;
  bucket.actual += actual ?? 0n;
  if (quoted !== null) bucket.quoted = (bucket.quoted ?? 0n) + quoted;
  if (expected !== null) bucket.expected = (bucket.expected ?? 0n) + expected;
  if (row.revenue_verified_paid === true) bucket.revenue_verified_paid_jobs += 1;

  if (profit !== null) {
    bucket.jobs_with_margin += 1;
    bucket.profit += profit;
    bucket.published_revenue += invoiced ?? 0n;
    bucket.published_cost += actual ?? 0n;
    if (row.cost_basis === "xero_project_inferred") bucket.inferred_jobs += 1;
  }
}

function presentBucket(bucket: Bucket): Record<string, unknown> {
  const margin = bucket.published_revenue === 0n
    ? null
    : Math.round((Number(bucket.profit) / Number(bucket.published_revenue)) * 1000) / 10;
  return {
    jobs: bucket.jobs,
    jobs_with_margin: bucket.jobs_with_margin,
    invoiced_ex: centsToNumber(bucket.invoiced),
    collected_ex: centsToNumber(bucket.collected),
    quoted_ex: centsToNumber(bucket.quoted),
    expected_cost_ex: centsToNumber(bucket.expected),
    actual_cost_ex: centsToNumber(bucket.actual),
    published_revenue_ex: centsToNumber(bucket.published_revenue),
    published_cost_ex: centsToNumber(bucket.published_cost),
    profit_ex: centsToNumber(bucket.profit),
    margin_pct: margin,
    inferred_jobs: bucket.inferred_jobs,
    revenue_verified_paid_jobs: bucket.revenue_verified_paid_jobs,
  };
}

// Perth (UTC+8, no daylight saving) calendar day boundaries as UTC instants.
function perthDayStartUtc(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - PERTH_OFFSET_MS).toISOString();
}

function perthNextDayStartUtc(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000 - PERTH_OFFSET_MS).toISOString();
}

function monthOf(row: Record<string, unknown>, dateField: "created" | "invoiced"): string | null {
  if (dateField === "invoiced") {
    const d = row.first_invoice_date;
    return typeof d === "string" && d.length >= 7 ? d.slice(0, 7) : null;
  }
  const created = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
  if (!Number.isFinite(created)) return null;
  return new Date(created + PERTH_OFFSET_MS).toISOString().slice(0, 7);
}

export async function jobProfitRollupAction(
  client: any,
  f: JobProfitRollupFilters,
  labels: Record<string, unknown>,
): Promise<JobProfitRollupResult> {
  const totals = emptyBucket();
  const byType = new Map<string | null, Bucket>();
  const byMonth = new Map<string | null, Bucket>();
  const seen = new Set<string>();
  const asOf = new Date().toISOString();

  try {
    for (let offset = 0;; offset += ROLLUP_PAGE_SIZE) {
      let query = client.from("v_job_profit").select(ROLLUP_COLUMNS);
      if (f.types.length) query = query.in("work_type", f.types);
      if (f.statuses.length) query = query.in("status", f.statuses);
      if (f.dateField === "invoiced") {
        if (f.from) query = query.gte("first_invoice_date", f.from);
        if (f.to) query = query.lte("first_invoice_date", f.to);
      } else {
        if (f.from) query = query.gte("created_at", perthDayStartUtc(f.from));
        if (f.to) query = query.lt("created_at", perthNextDayStartUtc(f.to));
      }
      query = query.order("created_at", { ascending: false }).order("job_id", { ascending: true })
        .range(offset, offset + ROLLUP_PAGE_SIZE - 1);

      const { data, error } = await query;
      if (error) {
        return { status: 500, body: { error: `job profit rollup read failed at row ${offset}: ${error.message}` } };
      }
      const rows: Record<string, unknown>[] = data || [];
      for (const row of rows) {
        const jobId = String(row.job_id ?? "");
        if (jobId && seen.has(jobId)) continue;
        if (jobId) seen.add(jobId);

        addRow(totals, row);
        const type = typeof row.work_type === "string" && row.work_type ? row.work_type : null;
        if (!byType.has(type)) byType.set(type, emptyBucket());
        addRow(byType.get(type)!, row);
        const month = monthOf(row, f.dateField);
        if (!byMonth.has(month)) byMonth.set(month, emptyBucket());
        addRow(byMonth.get(month)!, row);
      }
      if (rows.length < ROLLUP_PAGE_SIZE) break;
    }
  } catch (err) {
    return { status: 500, body: { error: `job profit rollup failed: ${err instanceof Error ? err.message : String(err)}` } };
  }

  const by_type = [...byType.entries()]
    .sort((a, b) => (a[1].invoiced === b[1].invoiced ? String(a[0] ?? "").localeCompare(String(b[0] ?? "")) : a[1].invoiced > b[1].invoiced ? -1 : 1))
    .map(([work_type, bucket]) => ({ work_type, ...presentBucket(bucket) }));

  const by_month = [...byMonth.entries()]
    .sort((a, b) => (a[0] === b[0] ? 0 : a[0] === null ? 1 : b[0] === null ? -1 : a[0] < b[0] ? -1 : 1))
    .map(([month, bucket]) => ({ month, ...presentBucket(bucket) }));

  return {
    status: 200,
    body: {
      view: "rollup",
      totals: presentBucket(totals),
      by_type,
      by_month,
      filters: { type: f.types, status: f.statuses, from: f.from, to: f.to, date_field: f.dateField },
      month_basis: f.dateField,
      as_of: asOf,
      labels,
    },
  };
}
