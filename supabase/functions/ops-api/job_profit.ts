// deno-lint-ignore-file no-explicit-any
// Job profit reads (job profitability PR 1).
//
// ops-api `job_profit` (one job: the engine's summary plus a dated money
// timeline) and `job_profit_list` (the engine's rows with filters). Both read
// the SQL engine from 20261009130000_job_profit_engine.sql and never compute a
// money figure here: every number on the response comes from v_job_profit,
// v_job_cost_events or v_job_revenue_events, so Jarvis, the ops API and the
// finance tab cannot disagree. view=rollup sums those same v_job_profit rows
// in job_profit_rollup.ts. The one exception is `patio_expected`
// (job_profit_patio_expected.ts): the patio scoper's own expected figures for
// its frozen revision, set beside the engine's actuals and never fed back
// into them. Read only. Field contract for the dashboard:
// docs/job-profit-read-contract.md (JOB_PROFIT_LABELS carries the same
// meanings on every response). The admin/owner gate lives at the
// dispatch in index.ts (privileged ops key or an admin/owner session).

import { jobProfitRollupAction } from "./job_profit_rollup.ts";
import {
  type FrozenAcceptance,
  INSTALLER_RULE_PROBE,
  lastSaveHashes,
  NO_REVISION_BINDING,
  PATIO_EXPECTED_SCOPE_PROJECTION,
  PATIO_FROZEN_REVISION_COLUMNS,
  PATIO_LAST_SAVE_HASH_COLUMNS,
  patioExpectedVersusActual,
} from "./job_profit_patio_expected.ts";
import {
  JOB_ACCEPTANCE_NOT_TRUE,
  readRevisionAcceptance,
} from "./job_profit_revision_binding.ts";

export const JOB_PROFIT_LABELS = {
  profit:
    "Gross profit on direct costs (trade labour, materials, commission and other direct lines), ex GST. No overhead share. Trade labour is the trade's charge; the company's super share is not added.",
  quoted_ex:
    "What was quoted: the value of a sent or accepted quote, ex GST. Null when no quote was sent. Never the live price. quoted_source names the quote it came from.",
  expected_cost_ex:
    "Expected cost fixed at the quote, ex GST, with expected_labour_ex, expected_materials_ex and expected_commission_ex. expected_source is frozen_at_acceptance, accepted_quote_revision or sent_quote_revision. Null when no cost was fixed at a quote, including a quote sent with no cost figures. Never a live pricing estimate.",
  actual_cost_ex:
    "Actual cost from the job's own lines only: trade charges, supplier bills and materials facts linked to the job (cost_basis is always line_level; line_level_cost_ex is the same figure). Never a Xero Project total.",
  xero_project_expenses_ex:
    "Expenses on record against the job's Xero Project. Evidence only, not the job's full cost: trade labour may sit outside it. Never part of actual cost, profit, margin or any company, work-type or month total. A Xero Project counts only when its name carries the job's own job number; one linked by contact only gives no figure and the job is flagged xero_project_linked_by_contact_only.",
  xero_project_exceeds_line_costs:
    "The Xero Project has more expenses on record than the costs linked to the job, so the job's full cost is unknown. Profit and margin are null until those expenses are linked to the job.",
  verified_paid:
    "Xero recorded the payment (status PAID; trade invoices paid). Not a bank reconciliation.",
  margin:
    "Null when job_financials would suppress it (no client invoice, no cost, no labour linked, incomplete trade invoice lines, unclassified lines), when the Xero Project total exceeds the costs linked to the job (xero_project_exceeds_line_costs), or when materials are owed but none is linked (labour-only cost).",
  profit_ex_unsuppressed:
    "Invoiced minus the costs linked so far, shown even where profit is suppressed. Not a profit figure. Null when the Xero Project total exceeds the costs linked to the job.",
  committed_open_ex:
    "Priced open purchase orders with no supplier invoice emailed and no bill placed, ex GST. Committed, not actual. An order with no price is never counted here as $0.00.",
  ordered_not_billed_count:
    "Ordered, not billed: sent purchase orders with no price (every Dispatch order) and no invoice or bill yet. A count, never a dollar figure. ordered_not_billed_over_30_count is those first sent 30 or more days ago.",
  invoice_emailed_count:
    "Invoice emailed, no bill matched to this order: the supplier emailed an invoice for the order, and no bill is linked to the order yet. The bill may already be on the job without a link to the order, so check before chasing it. Money owed or paid, never nothing owed. invoice_emailed_ex is the amount of the priced ones; it is in neither committed_open_ex nor actual cost.",
  rollup_expected_vs_actual:
    "Company view: expected against actual cost counts only jobs whose actual cost is complete (cost_flag ok or text_matched_lines). A job with an expected cost but partial actual cost (no cost linked, materials not linked, labour missing, unclassified or incomplete lines) is not comparable and is counted in jobs_with_expected_not_comparable instead. A group with no publishable job reads profit and margin as null (Unknown), never 0.",
  holding_jobs:
    "Holding jobs (costs parked on a bucket card, not a customer's job) are in no company, work-type or month total; their figures are reported on their own under holding_jobs.",
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
    | "purchase_order_ordered"
    | "purchase_order_invoice_emailed"
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
  po_ordered: "purchase_order_ordered",
  po_invoice_emailed: "purchase_order_invoice_emailed",
};

/** Timeline kind of a cost event. An unknown purchase order state is still a purchase order, never a supplier bill. */
export function costEventKind(source: unknown): TimelineEntry["kind"] {
  const s = String(source ?? "");
  return COST_KIND[s] ?? (s.startsWith("po_") ? "purchase_order" : "supplier_bill");
}

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
      kind: costEventKind(e.source),
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

  const [costs, revenue, patioScope, patioFrozen] = await Promise.all([
    client.from("v_job_cost_events").select(COST_EVENT_COLUMNS).eq(
      "job_id",
      summary.job_id,
    ).order("event_date", { ascending: true }).limit(2000),
    client.from("v_job_revenue_events").select(REVENUE_EVENT_COLUMNS).eq(
      "job_id",
      summary.job_id,
    ).order("invoice_date", { ascending: true }).limit(2000),
    // Projected paths only: scope_json can be megabytes of media.
    client.from("jobs").select(PATIO_EXPECTED_SCOPE_PROJECTION).eq(
      "id",
      summary.job_id,
    ).limit(1),
    // The job's frozen patio revision (earlier ones are superseded).
    client.from("scope_revisions").select(PATIO_FROZEN_REVISION_COLUMNS).eq(
      "job_id",
      summary.job_id,
    ).eq("status", "frozen").eq("tool_kind", "patio")
      .order("revision_number", { ascending: false }).limit(1),
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
      ...(await patioExpectedPart(client, patioScope, patioFrozen, summary)),
    },
  };
}

// Present only for a patio scoper 2.0 job, or when its scope could not be
// read; every other job's response is unchanged.
async function patioExpectedPart(
  client: any,
  current: { data: any[] | null; error: { message: string } | null },
  frozen: { data: any[] | null; error: { message: string } | null },
  summary: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const failed = current.error
    ? `job scope read failed: ${current.error.message}`
    : frozen.error
    ? `frozen scope read failed: ${frozen.error.message}`
    : null;
  if (failed) {
    return { patio_expected: { status: "unreadable", error: failed } };
  }
  const cur = current.data?.[0] ?? null;
  const frz = frozen.data?.[0] ?? null;
  // Only a patio job with a frozen row needs the whole last save, to compare
  // it with the frozen row by hash. A failed read leaves freshness unchecked
  // (flagged), never assumed.
  let hashes = null;
  if (frz && (cur?.ptool === "patio-scoper" || frz.tool_kind === "patio")) {
    const full = await client.from("jobs").select(PATIO_LAST_SAVE_HASH_COLUMNS)
      .eq("id", summary.job_id).limit(1);
    if (!full.error) hashes = await lastSaveHashes(full.data?.[0] ?? null);
  }
  // JP-12: only an engine that has the installer rule can say an installer
  // bill was confirmed. Asked for a patio job only; an error is not known.
  let installerCheck: boolean | null = null;
  if (frz || cur?.ptool === "patio-scoper") {
    const probe = await client.rpc(INSTALLER_RULE_PROBE, { p_line_items: [] });
    installerCheck = !probe.error && probe.data === false ? true : null;
  }
  // A freeze is not an acceptance: only recorded acceptance on the job lets
  // the frozen revision be compared with actuals. Found evidence counts even
  // if the other read failed; a failed read with none found is not known.
  let acceptance: FrozenAcceptance | null = null;
  if (frz) {
    const [docs, runs] = await Promise.all([
      client.from("job_documents").select("id").eq("job_id", summary.job_id)
        .eq("type", "quote").not("accepted_at", "is", null).limit(1),
      client.from("run_acceptances").select("id").eq("job_id", summary.job_id)
        .eq("status", "accepted").limit(1),
    ]);
    acceptance = !docs.error && (docs.data?.length ?? 0) > 0
      ? { accepted: true, source: "job_documents.accepted_at" }
      : !runs.error && (runs.data?.length ?? 0) > 0
      ? { accepted: true, source: "run_acceptances" }
      : docs.error || runs.error
      ? { accepted: null, source: null }
      : { accepted: false, source: null };
  }
  // Whether that acceptance is this frozen revision's: read from the chain
  // accepted document -> released quote_revisions row -> scope_revision_id
  // (JP-23 slice 2). It can only narrow job acceptance. Until the send link
  // (slice 1) exists every job reads not known, and nothing is compared.
  const revisionAcceptance = !frz
    ? NO_REVISION_BINDING
    : acceptance?.accepted === true
    ? await readRevisionAcceptance(
      client,
      String(summary.job_id),
      typeof frz.id === "string" ? frz.id : null,
    )
    : JOB_ACCEPTANCE_NOT_TRUE;
  const result = patioExpectedVersusActual(
    cur,
    frz,
    summary,
    hashes,
    installerCheck,
    acceptance,
    revisionAcceptance,
  );
  return result ? { patio_expected: result } : {};
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
