// deno-lint-ignore-file no-explicit-any
// Job profit reads (job profitability PR 1).
//
// ops-api `job_profit` (one job: the engine's summary plus a dated money
// timeline) and `job_profit_list` (the engine's rows with filters). Both read
// the SQL engine from 20261009130000_job_profit_engine.sql and never compute a
// money figure here: every number on the response comes from v_job_profit,
// v_job_cost_events or v_job_revenue_events, so Jarvis, the ops API and the
// finance tab cannot disagree. view=rollup sums those same v_job_profit rows
// in job_profit_rollup.ts. Read only. Field contract for the dashboard:
// docs/job-profit-read-contract.md (JOB_PROFIT_LABELS carries the same
// meanings on every response). The admin/owner gate lives at the
// dispatch in index.ts (privileged ops key or an admin/owner session).

import { jobProfitRollupAction } from "./job_profit_rollup.ts";

export const JOB_PROFIT_LABELS = {
  profit:
    "Gross profit on direct costs (trade labour, materials, commission and other direct lines), ex GST. No overhead share. Trade labour is the trade's charge; the company's super share is not added.",
  quoted_ex:
    "What was quoted, ex GST: a sent or accepted quote. On a patio, while job_profit_patio_quote_v1 is on, the accepted patio tool quote when that figure is unambiguous. Null when no quote was sent, or when the patio figure conflicts or cannot be read. Never the live price. quoted_source names which one.",
  expected_cost_ex:
    "Expected cost, ex GST. Labour is the quote's, or, while job_profit_work_order_labour_v1 is on and the job work order has agreed labour, that figure plus approved customer variations. Materials and commission stay the quote's. expected_source may be job_work_order, frozen_at_acceptance, accepted_quote_revision or sent_quote_revision. Null when no cost was fixed and no agreed labour applies. Never a live estimate.",
  actual_cost_ex:
    "Actual cost from the job's own lines only: trade charges, supplier bills and materials facts linked to the job (cost_basis is always line_level; line_level_cost_ex is the same figure). Never a Xero Project total, even when the published margin uses the project figure.",
  xero_project_expenses_ex:
    "Expenses on record against the job's Xero Project. Evidence. While job_profit_xero_project_cost_v1 is on and this exceeds the linked lines, margin_cost_ex uses it. Trade labour may sit outside it. A Xero Project counts only when its name carries the job's own job number; one linked by contact only gives no figure and the job is flagged xero_project_linked_by_contact_only.",
  xero_project_exceeds_line_costs:
    "The Xero Project has more expenses on record than the costs linked to the job. While job_profit_xero_project_cost_v1 is off, profit and margin are null. While it is on, the margin uses the project figure and margin_source is from Xero Project. actual_cost_ex stays the linked lines. Trade labour may sit outside the project.",
  verified_paid:
    "Xero recorded the payment (status PAID; trade invoices paid). Not a bank reconciliation.",
  margin:
    "Null when there is no client invoice, incomplete invoice lines, or unclassified lines. While job_profit_xero_project_cost_v1 is off, also null when no cost is linked, no labour is linked, materials are owed but unlinked, or the Xero Project exceeds the linked costs. While it is on and the project exceeds, the margin is invoiced minus the project expenses unless the invoice, incomplete-line or unclassified-line stop still applies.",
  profit_ex_unsuppressed:
    "Invoiced minus the costs linked so far, shown even where profit is suppressed. Not a profit figure. Null when the Xero Project total exceeds the costs linked to the job.",
  margin_source:
    "line_level when the published margin uses linked costs. from Xero Project when job_profit_xero_project_cost_v1 is on and the margin uses the project figure. Null when no margin is published.",
  margin_cost_ex:
    "The cost the published margin subtracted: the Xero Project figure, or actual_cost_ex. Null when no margin is published. actual_cost_ex is unchanged.",
  expected_labour_quote_ex:
    "Expected labour from the quote snapshot, even when expected_labour_ex is the job work order figure.",
  work_order_agreed_labour_ex:
    "Job work order agreed labour ex GST, including approved customer-variation trade allocation. Shown even while the labour switch is off. Null when the job work order has no agreed figure.",
} as const;

/**
 * Deliberately strict, like the other money surfaces: a server key (the
 * service key or the agent server key, both auth mode api_key) or an
 * admin/owner session. ops_manager, trades and the routine are refused.
 */
export function jobProfitCallerAllowed(
  authMode: string,
  role: string | null | undefined,
): boolean {
  if (authMode === "api_key") return true;
  const r = String(role || "").toLowerCase();
  return authMode === "jwt" && (r === "admin" || r === "owner");
}

export type JobProfitResult = { status: number; body: Record<string, unknown> };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_TOKEN_RE = /^[a-z_]{1,40}$/;
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

const COST_EVENT_COLUMNS =
  "job_id, event_date, lane, lane_detail, party_kind, party_id, party, amount_ex, source, source_id, document_id, document_number, document_status, paid, paid_on, confidence, is_actual, description, hours, account_code, business_unit, match_method";
const REVENUE_EVENT_COLUMNS =
  "job_id, kind, invoice_date, amount_ex, status, paid, paid_on, counts_as_invoiced, source_id, document_id, document_number, party, description, account_code, business_unit";

export type TimelineEntry = {
  date: string | null;
  kind:
    | "trade_charge"
    | "supplier_bill"
    | "materials_fact"
    | "purchase_order"
    | "sales_invoice"
    | "variation"
    | "sales_invoice_paid"
    | "cost_paid";
  lane: string | null;
  party: string | null;
  amount_ex: number | null;
  counts: boolean;
  paid: boolean | null;
  paid_on: string | null;
  source: string;
  source_id: string;
  document_number: string | null;
  document_status: string | null;
  confidence: string | null;
  description: string | null;
  hours: number | null;
};

const COST_KIND: Record<string, TimelineEntry["kind"]> = {
  trade_line: "trade_charge",
  supplier_bill: "supplier_bill",
  materials_fact: "materials_fact",
  po_committed: "purchase_order",
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The financial job story: every cost and revenue event, plus one "paid" entry
 * per paid document (summed from the same event rows), oldest first. Pure.
 */
export function buildJobProfitTimeline(
  costEvents: any[],
  revenueEvents: any[],
): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const e of costEvents) {
    out.push({
      date: e.event_date ?? null,
      kind: COST_KIND[e.source] ?? "supplier_bill",
      lane: e.lane ?? null,
      party: e.party ?? null,
      amount_ex: num(e.amount_ex),
      counts: e.is_actual === true,
      paid: typeof e.paid === "boolean" ? e.paid : null,
      paid_on: e.paid_on ?? null,
      source: e.source,
      source_id: e.source_id,
      document_number: e.document_number ?? null,
      document_status: e.document_status ?? null,
      confidence: e.confidence ?? null,
      description: e.description ?? null,
      hours: num(e.hours),
    });
  }
  for (const e of revenueEvents) {
    out.push({
      date: e.invoice_date ?? null,
      kind: e.kind === "variation" ? "variation" : "sales_invoice",
      lane: null,
      party: e.party ?? null,
      amount_ex: num(e.amount_ex),
      counts: e.counts_as_invoiced === true,
      paid: typeof e.paid === "boolean" ? e.paid : null,
      paid_on: e.paid_on ?? null,
      source: e.kind === "variation" ? "variation" : "sales_invoice_line",
      source_id: e.source_id,
      document_number: e.document_number ?? null,
      document_status: e.status ?? null,
      confidence: null,
      description: e.description ?? null,
      hours: null,
    });
  }

  // One paid entry per paid document, on its paid date.
  const paidDocs = new Map<string, TimelineEntry>();
  const addPaid = (
    key: string,
    kind: TimelineEntry["kind"],
    e: any,
    date: string,
    amount: number | null,
  ) => {
    const prior = paidDocs.get(key);
    if (prior) {
      prior.amount_ex = prior.amount_ex === null || amount === null
        ? null
        : round2(prior.amount_ex + amount);
      return;
    }
    paidDocs.set(key, {
      date,
      kind,
      lane: null,
      party: e.party ?? null,
      amount_ex: amount,
      counts: false,
      paid: true,
      paid_on: date,
      source: kind === "sales_invoice_paid" ? "sales_invoice" : e.source,
      source_id: String(e.document_id ?? e.source_id),
      document_number: e.document_number ?? null,
      document_status: e.status ?? e.document_status ?? null,
      confidence: null,
      description: null,
      hours: null,
    });
  };
  for (const e of revenueEvents) {
    if (
      e.kind === "invoice_line" && e.counts_as_invoiced && e.paid && e.paid_on
    ) {
      addPaid(
        `rev:${e.document_id}`,
        "sales_invoice_paid",
        e,
        e.paid_on,
        num(e.amount_ex),
      );
    }
  }
  for (const e of costEvents) {
    if (e.is_actual && e.paid && e.paid_on && e.document_id) {
      addPaid(
        `cost:${e.source}:${e.document_id}`,
        "cost_paid",
        e,
        e.paid_on,
        num(e.amount_ex),
      );
    }
  }
  out.push(...paidDocs.values());

  return out.sort((a, b) => {
    const da = a.date ?? "9999-12-31";
    const db = b.date ?? "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return `${a.kind}:${a.source_id}` < `${b.kind}:${b.source_id}` ? -1 : 1;
  });
}

/** Parse job_profit_list filters. Returns an error message for a bad filter. */
export function parseJobProfitListFilters(params: URLSearchParams):
  | {
    ok: true;
    types: string[];
    statuses: string[];
    from: string | null;
    to: string | null;
    dateField: "created" | "invoiced";
    limit: number;
    offset: number;
  }
  | { ok: false; error: string } {
  const list = (name: string): string[] | null => {
    const raw = (params.get(name) || "").trim();
    if (!raw) return [];
    const parts = raw.split(",").map((p) => p.trim().toLowerCase()).filter(
      Boolean,
    );
    return parts.every((p) => LIST_TOKEN_RE.test(p)) ? parts : null;
  };
  const types = list("type");
  if (types === null) {
    return {
      ok: false,
      error: "type must be a comma-separated list of job types",
    };
  }
  const statuses = list("status");
  if (statuses === null) {
    return {
      ok: false,
      error: "status must be a comma-separated list of job statuses",
    };
  }
  const from = params.get("from");
  const to = params.get("to");
  if (from && !DATE_RE.test(from)) {
    return { ok: false, error: "from must be YYYY-MM-DD" };
  }
  if (to && !DATE_RE.test(to)) {
    return { ok: false, error: "to must be YYYY-MM-DD" };
  }
  const dateFieldRaw = params.get("date_field") || "created";
  if (dateFieldRaw !== "created" && dateFieldRaw !== "invoiced") {
    return { ok: false, error: "date_field must be created or invoiced" };
  }
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const limit = limitRaw === null ? LIST_DEFAULT_LIMIT : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
    return { ok: false, error: `limit must be 1 to ${LIST_MAX_LIMIT}` };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, error: "offset must be 0 or more" };
  }
  return {
    ok: true,
    types,
    statuses,
    from,
    to,
    dateField: dateFieldRaw,
    limit,
    offset,
  };
}

/** ops-api `job_profit`: one job's numbers and its dated money timeline. */
export async function jobProfitAction(
  client: any,
  params: URLSearchParams,
): Promise<JobProfitResult> {
  const jobIdParam = (params.get("job_id") || params.get("jobId") || "").trim();
  const jobNumber = (params.get("job_number") || params.get("jobNumber") || "")
    .trim().toUpperCase();
  if (!jobIdParam && !jobNumber) {
    return { status: 400, body: { error: "job_id or job_number required" } };
  }
  if (jobIdParam && !UUID_RE.test(jobIdParam)) {
    return { status: 400, body: { error: "job_id must be a UUID" } };
  }
  if (!jobIdParam && !/^[A-Z0-9-]{3,40}$/.test(jobNumber)) {
    return { status: 400, body: { error: "job_number is not a job number" } };
  }

  let jobId = jobIdParam;
  if (!jobId) {
    const { data: jobs, error: jobError } = await client.from("jobs")
      .select("id")
      .eq("job_number", jobNumber)
      .limit(2);
    if (jobError) {
      return {
        status: 500,
        body: { error: `job number lookup failed: ${jobError.message}` },
      };
    }
    if (!jobs || jobs.length === 0) {
      return { status: 404, body: { error: "no job matches that job number" } };
    }
    if (jobs.length > 1) {
      return {
        status: 409,
        body: {
          error: "job_number matches more than one job; pass job_id",
          job_ids: jobs.map((r: any) => r.id),
        },
      };
    }
    jobId = jobs[0].id;
  }

  const { data: rows, error } = await client.from("v_job_profit")
    .select("*")
    .eq("job_id", jobId)
    .limit(2);
  if (error) {
    return {
      status: 500,
      body: { error: `job profit read failed: ${error.message}` },
    };
  }
  if (!rows || rows.length === 0) {
    return { status: 404, body: { error: "no job profit row for that job" } };
  }
  if (rows.length > 1) {
    return {
      status: 500,
      body: { error: "job profit view returned more than one row for a job" },
    };
  }
  const summary = rows[0];

  const [costs, revenue] = await Promise.all([
    client.from("v_job_cost_events").select(COST_EVENT_COLUMNS).eq(
      "job_id",
      summary.job_id,
    ).order("event_date", { ascending: true }).limit(2000),
    client.from("v_job_revenue_events").select(REVENUE_EVENT_COLUMNS).eq(
      "job_id",
      summary.job_id,
    ).order("invoice_date", { ascending: true }).limit(2000),
  ]);
  if (costs.error) {
    return {
      status: 500,
      body: { error: `job cost events read failed: ${costs.error.message}` },
    };
  }
  if (revenue.error) {
    return {
      status: 500,
      body: {
        error: `job revenue events read failed: ${revenue.error.message}`,
      },
    };
  }

  const costEvents = costs.data || [];
  const revenueEvents = revenue.data || [];
  const trades = new Map<
    string,
    {
      party_id: string | null;
      party: string;
      amount_ex: number;
      lines: number;
      first: string | null;
      last: string | null;
    }
  >();
  for (const e of costEvents) {
    if (e.source !== "trade_line" || !e.is_actual) continue;
    const key = e.party_id ? `id:${e.party_id}` : `line:${e.source_id}`;
    const t = trades.get(key) ??
      {
        party_id: e.party_id ?? null,
        party: e.party,
        amount_ex: 0,
        lines: 0,
        first: null,
        last: null,
      };
    t.amount_ex = round2(t.amount_ex + (num(e.amount_ex) ?? 0));
    t.lines += 1;
    if (e.event_date && (!t.first || e.event_date < t.first)) {
      t.first = e.event_date;
    }
    if (e.event_date && (!t.last || e.event_date > t.last)) {
      t.last = e.event_date;
    }
    trades.set(key, t);
  }

  return {
    status: 200,
    body: {
      job: summary,
      trades: [...trades.values()].sort((a, b) => b.amount_ex - a.amount_ex),
      cost_events: costEvents,
      revenue_events: revenueEvents,
      timeline: buildJobProfitTimeline(costEvents, revenueEvents),
      labels: JOB_PROFIT_LABELS,
    },
  };
}

/** ops-api `job_profit_list`: the engine's rows, filtered. */
export async function jobProfitListAction(
  client: any,
  params: URLSearchParams,
): Promise<JobProfitResult> {
  const f = parseJobProfitListFilters(params);
  if (!f.ok) return { status: 400, body: { error: f.error } };
  const view = params.get("view");
  if (view === "rollup") {
    return await jobProfitRollupAction(client, f, JOB_PROFIT_LABELS);
  }
  if (view !== null) {
    return { status: 400, body: { error: "view must be rollup or omitted" } };
  }
  // No row count: a planned count makes PostgREST refuse (416) any offset at
  // or above the planner's estimate, and work_type is computed, so that
  // estimate is about 1 for every type filter. One row past the page says
  // whether another page exists.
  let query = client.from("v_job_profit").select("*");
  if (f.types.length) query = query.in("work_type", f.types);
  if (f.statuses.length) query = query.in("status", f.statuses);
  const dateColumn = f.dateField === "invoiced"
    ? "first_invoice_date"
    : "created_at";
  if (f.from) {
    query = query.gte(
      dateColumn,
      f.dateField === "invoiced" ? f.from : `${f.from}T00:00:00+08:00`,
    );
  }
  if (f.to) {
    query = query.lte(
      dateColumn,
      f.dateField === "invoiced" ? f.to : `${f.to}T23:59:59.999+08:00`,
    );
  }
  query = query.order("created_at", { ascending: false }).order("job_id", {
    ascending: true,
  })
    .range(f.offset, f.offset + f.limit);
  const { data, error } = await query;
  if (error) {
    return {
      status: 500,
      body: { error: `job profit list read failed: ${error.message}` },
    };
  }
  const rows: unknown[] = data || [];
  return {
    status: 200,
    body: {
      jobs: rows.slice(0, f.limit),
      has_more: rows.length > f.limit,
      limit: f.limit,
      offset: f.offset,
      filters: {
        type: f.types,
        status: f.statuses,
        from: f.from,
        to: f.to,
        date_field: f.dateField,
      },
      labels: JOB_PROFIT_LABELS,
    },
  };
}
