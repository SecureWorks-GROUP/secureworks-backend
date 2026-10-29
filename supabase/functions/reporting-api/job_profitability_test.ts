// deno-lint-ignore-file no-explicit-any no-import-prefix
// reporting-api job_profitability (CFO-01 / R-22): money from v_job_profit,
// an unknown margin is null with a reason, never 0.
//
// Pins:
//   Unknown     a job the engine cannot publish a margin for reads margin and
//               margin_pct null, margin_status 'unknown' and a worded reason;
//               nothing placed reads bills null, not $0.
//   Known       a margin_ok job carries the engine's profit_ex / margin_pct.
//   Average     avg_margin_pct is revenue-weighted over margin-known jobs only;
//               total_margin never folds an unknown cost in as $0.
//   Holding     a holding job is in no summary figure, reported on its own.
//   Keys        every earlier row and summary key is still present.
//   Route       the action reads the selected jobs, then v_job_profit for
//               those ids (chunked), and a failed money read fails the answer.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildJobProfitability,
  FULL_DETAIL_ROW_KEYS,
  FULL_DETAIL_SUMMARY_KEYS,
  jobProfitabilityAction,
  jobProfitabilityLimit,
  PROFIT_READ_CHUNK,
  PROFIT_READ_CONCURRENCY,
} from "./job_profitability.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

function job(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    job_number: `SWF-${id}`,
    client_name: `Client ${id}`,
    type: "fencing",
    status: "complete",
    created_at: "2026-10-10T00:00:00Z",
    ...extra,
  };
}

function profit(id: string, extra: Record<string, unknown> = {}) {
  return {
    job_id: id,
    job_number: `SWF-${id}`,
    work_type: "fencing",
    quoted_ex: "10000.00",
    quoted_source: "sent_quote:whole_job_total:quote",
    expected_source: "frozen_at_acceptance",
    expected_cost_ex: "6000.00",
    committed_open_ex: 0,
    ordered_not_billed_count: 0,
    invoice_emailed_count: 0,
    invoice_emailed_ex: null,
    actual_cost_ex: 0,
    actual_cost_events: 0,
    xero_project_expenses_ex: null,
    xero_project_count: 0,
    invoiced_ex: 0,
    draft_revenue_ex: 0,
    collected_ex: 0,
    invoice_count: 0,
    profit_ex: null,
    margin_pct: null,
    revenue_flag: "ok",
    cost_flag: "ok",
    completeness: [],
    margin_ok: false,
    holding_job: false,
    ...extra,
  };
}

// Known: $10,000 invoiced, $7,000 placed, profit $3,000 (30%).
const KNOWN = profit("1", {
  invoiced_ex: "10000.00",
  invoice_count: 1,
  actual_cost_ex: "7000.00",
  actual_cost_events: 4,
  profit_ex: "3000.00",
  margin_pct: "30.0",
  margin_ok: true,
});
// Known: $5,000 invoiced, $4,000 placed, profit $1,000 (20%).
const KNOWN_2 = profit("2", {
  invoiced_ex: 5000,
  invoice_count: 1,
  actual_cost_ex: 4000,
  actual_cost_events: 2,
  profit_ex: 1000,
  margin_pct: 20,
  margin_ok: true,
});
// Unknown: invoiced $8,000, no cost linked. The old route read this as 100%.
const NO_COST = profit("3", {
  invoiced_ex: 8000,
  invoice_count: 1,
  cost_flag: "no_cost_linked",
  completeness: ["no_cost_linked", "open_purchase_orders"],
  committed_open_ex: 1200,
});
// Unknown: labour placed, materials owed but not linked.
const NO_MATERIALS = profit("4", {
  invoiced_ex: 6000,
  invoice_count: 1,
  actual_cost_ex: 1500,
  actual_cost_events: 1,
  cost_flag: "materials_not_linked",
  completeness: ["materials_not_linked", "text_matched_lines"],
});
// Holding job with a "known" margin: never in the summary.
const HOLDING = profit("5", {
  invoiced_ex: 100000,
  invoice_count: 1,
  actual_cost_ex: 1000,
  actual_cost_events: 9,
  profit_ex: 99000,
  margin_pct: 99,
  margin_ok: true,
  holding_job: true,
  completeness: ["holding_job"],
});

const JOBS = ["1", "2", "3", "4", "5"].map((id) => job(id));
const PROFITS = [KNOWN, KNOWN_2, NO_COST, NO_MATERIALS, HOLDING];

function full(
  jobs: Record<string, unknown>[],
  rows: Record<string, unknown>[],
) {
  return buildJobProfitability(jobs, rows, "full");
}

function rowOf(body: any, id: string) {
  return body.jobs.find((r: any) => r.id === id);
}

Deno.test("unknown cost: margin and margin_pct are null with a worded reason", () => {
  const body: any = full(JOBS, PROFITS);
  const r = rowOf(body, "3");
  assertEquals(r.margin, null);
  assertEquals(r.margin_pct, null);
  assertEquals(r.margin_status, "unknown");
  assertEquals(r.margin_ok, false);
  assertEquals(r.margin_reason_codes, ["no_cost_linked"]);
  assertEquals(r.margin_reason, "Unknown: no cost linked to the job yet");
  // nothing placed is Unknown, not $0
  assertEquals(r.bills, null);
  assertEquals(r.actual_cost_ex, null);
  assertEquals(r.invoiced, 8000);
  // expected, committed and actual stay separate (R-22)
  assertEquals(r.expected_cost_ex, 6000);
  assertEquals(r.committed_open_ex, 1200);
  assertEquals(r.money_source, "v_job_profit");

  const m = rowOf(body, "4");
  assertEquals(m.margin, null);
  assertEquals(m.margin_pct, null);
  assertEquals(m.margin_reason_codes, ["materials_not_linked"]);
  assertEquals(
    m.margin_reason,
    "Unknown: materials are owed but none is linked",
  );
  assertEquals(m.bills, 1500); // placed so far, labelled placed costs only
  assertEquals(m.bills_basis, "placed_costs_only");
});

Deno.test("known cost: the engine's profit and margin are published", () => {
  const body: any = full(JOBS, PROFITS);
  const r = rowOf(body, "1");
  assertEquals(r.margin_status, "known");
  assertEquals(r.margin_reason, null);
  assertEquals(r.margin_reason_codes, []);
  assertEquals(r.margin, 3000);
  assertEquals(r.margin_pct, 30);
  assertEquals(r.bills, 7000);
  assertEquals(r.quote_value, 10000);
});

Deno.test("average: over margin-known customer jobs only, unknowns never folded in as $0", () => {
  const body: any = full(JOBS, PROFITS);
  const s = body.summary;
  // (3000 + 1000) / (10000 + 5000) = 26.7%. The old route's
  // (invoiced - bills) / invoiced over every row would read
  // (29000 - 12500) / 29000 = 56.9% (with the holding job, far higher).
  assertEquals(s.avg_margin_pct, 26.7);
  assertEquals(
    s.avg_margin_basis,
    "revenue_weighted_over_margin_known_customer_jobs",
  );
  assertEquals(s.total_margin, 4000);
  assertEquals(s.margin_known_invoiced, 15000);
  assertEquals(s.margin_known_costs, 11000);
  assertEquals(s.jobs_margin_known, 2);
  assertEquals(s.jobs_margin_unknown, 2);
  assertEquals(s.customer_jobs, 4);
  assertEquals(s.unknown_reasons, {
    no_cost_linked: 1,
    materials_not_linked: 1,
  });
  // placed costs only, and labelled incomplete
  assertEquals(s.total_bills, 7000 + 4000 + 1500);
  assertEquals(s.total_bills_basis, "placed_costs_only");
  assertEquals(s.costs_complete, false);
  assertEquals(s.total_invoiced, 10000 + 5000 + 8000 + 6000);
  assertEquals(s.money_source, "v_job_profit");
});

Deno.test("average: null (Unknown) when no job's margin is known, never 0", () => {
  const body: any = full([job("3"), job("4")], [
    NO_COST,
    NO_MATERIALS,
  ]);
  assertEquals(body.summary.avg_margin_pct, null);
  assertEquals(body.summary.total_margin, null);
  assertEquals(body.summary.margin_known_invoiced, null);
  assertEquals(body.summary.jobs_margin_known, 0);
  assertEquals(body.summary.costs_complete, false);
});

Deno.test("holding job: in no summary figure, reported on its own", () => {
  const body: any = full(JOBS, PROFITS);
  const s = body.summary;
  const h = rowOf(body, "5");
  assertEquals(h.holding_job, true);
  assertEquals(s.total_jobs, 5); // every row is still returned
  assertEquals(s.holding_jobs, {
    jobs: 1,
    invoiced: 100000,
    placed_costs: 1000,
    job_numbers: ["SWF-5"],
  });
  assert(s.total_invoiced < 100000);
  // only the holding job known: average stays Unknown
  const only: any = full([job("5"), job("3")], [
    HOLDING,
    NO_COST,
  ]);
  assertEquals(only.summary.avg_margin_pct, null);
  assertEquals(only.summary.jobs_margin_known, 0);
  assertEquals(only.summary.jobs_margin_unknown, 1);
});

Deno.test("a job missing from the engine is Unknown with a reason, not $0", () => {
  const body: any = full([job("9")], []);
  const r = body.jobs[0];
  assertEquals(r.invoiced, null);
  assertEquals(r.bills, null);
  assertEquals(r.margin, null);
  assertEquals(r.margin_pct, null);
  assertEquals(r.margin_reason_codes, ["not_in_job_profit_engine"]);
  assertEquals(r.data_source, "none");
  assertEquals(body.summary.costs_complete, false);
  // kept out of every money sum, and counted on its own
  assertEquals(body.summary.total_invoiced, 0);
  assertEquals(body.summary.jobs_not_in_engine, 1);
  assertEquals(body.summary.unknown_reasons, { not_in_job_profit_engine: 1 });
});

Deno.test("keys: every earlier row and summary key is kept", () => {
  const body: any = full(JOBS, PROFITS);
  for (
    const k of [
      "id",
      "job_number",
      "client_name",
      "type",
      "status",
      "quote_value",
      "invoiced",
      "bills",
      "margin",
      "margin_pct",
      "data_source",
    ]
  ) {
    assert(k in body.jobs[0], `row key ${k}`);
  }
  for (
    const k of [
      "total_jobs",
      "total_invoiced",
      "total_bills",
      "total_margin",
      "avg_margin_pct",
      "data_sources",
      "xero_projects_matched",
    ]
  ) {
    assert(k in body.summary, `summary key ${k}`);
  }
});

Deno.test("data_source: evidence presence only", () => {
  const body: any = full(
    [job("1"), job("6"), job("7")],
    [
      KNOWN,
      profit("6", { xero_project_count: 1, xero_project_expenses_ex: 900 }),
      profit("7"),
    ],
  );
  assertEquals(rowOf(body, "1").data_source, "invoice_match");
  assertEquals(rowOf(body, "6").data_source, "xero_projects");
  // the Xero Project total is evidence only: never a cost or a margin
  assertEquals(rowOf(body, "6").bills, null);
  assertEquals(rowOf(body, "6").margin, null);
  assertEquals(rowOf(body, "7").data_source, "none");
  assertEquals(body.summary.data_sources, {
    invoice_match: 1,
    xero_projects: 1,
    none: 1,
  });
  assertEquals(body.summary.xero_projects_matched, 1);
});

// ── route: a stub client that records every read ──

type Call = { table: string; ops: [string, unknown[]][] };

function stubClient(
  tables: Record<string, (call: Call) => unknown>,
) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder: any = {};
      for (const op of ["select", "eq", "in", "gte", "lte", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      builder.then = (resolve: any, reject: any) =>
        Promise.resolve(tables[table](call)).then(resolve, reject);
      return builder;
    },
  };
}

Deno.test("route: same jobs filters, then v_job_profit for those ids in chunks", async () => {
  const many = Array.from(
    { length: PROFIT_READ_CHUNK + 5 },
    (_, i) => job(`j${i}`),
  );
  const sb = stubClient({
    jobs: () => ({ data: many, error: null }),
    v_job_profit: (call) => {
      const ids = call.ops.find(([op]) => op === "in")![1][1] as string[];
      return { data: ids.map((id) => profit(id)), error: null };
    },
  });
  const params = new URLSearchParams({
    type: "fencing",
    status: "complete",
    from: "2026-10-01",
    to: "2026-10-31",
    limit: "500",
  });
  const body: any = await jobProfitabilityAction(sb, params, ORG);

  const jobsCall = sb.calls[0];
  assertEquals(jobsCall.table, "jobs");
  const ops = jobsCall.ops.map(([op, args]) => `${op}:${JSON.stringify(args)}`);
  for (
    const want of [
      `eq:["org_id","${ORG}"]`,
      `eq:["legacy",false]`,
      `eq:["type","fencing"]`,
      `eq:["status","complete"]`,
      `gte:["created_at","2026-10-01"]`,
      `lte:["created_at","2026-10-31"]`,
      `limit:[500]`,
    ]
  ) assert(ops.includes(want), `jobs read missing ${want}`);

  const profitCalls = sb.calls.filter((c) => c.table === "v_job_profit");
  assertEquals(profitCalls.length, 2);
  for (const c of profitCalls) {
    assert(
      c.ops.some(([op, args]) =>
        op === "eq" && args[0] === "org_id" && args[1] === ORG
      ),
    );
  }
  assertEquals(body.jobs.length, many.length);
  assertEquals(body.summary.money_source, "v_job_profit");
  assertEquals(body.summary.jobs_margin_unknown, many.length);
  assertEquals(body.summary.avg_margin_pct, null);
});

Deno.test("route: a failed v_job_profit read fails the answer", async () => {
  const sb = stubClient({
    jobs: () => ({ data: [job("1")], error: null }),
    v_job_profit: () => ({ data: null, error: { message: "boom" } }),
  });
  await assertRejects(
    () => jobProfitabilityAction(sb, new URLSearchParams(), ORG),
    Error,
    "v_job_profit read failed: boom",
  );
});

Deno.test("route: no jobs reads no money and returns an empty, honest summary", async () => {
  const sb = stubClient({
    jobs: () => ({ data: [], error: null }),
    v_job_profit: () => {
      throw new Error("should not be read");
    },
  });
  const body: any = await jobProfitabilityAction(
    sb,
    new URLSearchParams(),
    ORG,
  );
  assertEquals(body.jobs, []);
  assertEquals(body.summary.total_jobs, 0);
  assertEquals(body.summary.avg_margin_pct, null);
  assertEquals(body.summary.total_margin, null);
});

// ── round 2 (independent review of #1197) ──

Deno.test("access: a basic (non-staff) caller gets the earlier keys plus the Unknown rule only", () => {
  const body: any = buildJobProfitability(JOBS, PROFITS, "basic");
  assertEquals(body.summary.detail, "basic");
  for (const r of body.jobs) {
    for (const k of FULL_DETAIL_ROW_KEYS) assert(!(k in r), `row leaks ${k}`);
  }
  for (const k of FULL_DETAIL_SUMMARY_KEYS) {
    assert(!(k in body.summary), `summary leaks ${k}`);
  }
  // the Unknown-not-zero rule still applies to the earlier keys
  const unknown = rowOf(body, "3");
  assertEquals(unknown.margin, null);
  assertEquals(unknown.margin_pct, null);
  assertEquals(unknown.bills, null);
  assertEquals(unknown.margin_status, "unknown");
  assertEquals(unknown.margin_reason, "Unknown: no cost linked to the job yet");
  assertEquals(body.summary.avg_margin_pct, 26.7);
  assertEquals(body.summary.jobs_margin_unknown, 2);
  assertEquals(body.summary.costs_complete, false);
  assertEquals(body.summary.holding_jobs_excluded, 1);
  assertEquals(
    Object.keys(rowOf(body, "1")).sort(),
    [
      "bills",
      "bills_basis",
      "client_name",
      "data_source",
      "holding_job",
      "id",
      "invoiced",
      "job_number",
      "margin",
      "margin_ok",
      "margin_pct",
      "margin_reason",
      "margin_reason_codes",
      "margin_status",
      "money_source",
      "quote_value",
      "status",
      "type",
    ],
  );
});

Deno.test("access: a full (staff or server) caller gets every detail field", () => {
  const body: any = buildJobProfitability(JOBS, PROFITS, "full");
  assertEquals(body.summary.detail, "full");
  for (const k of FULL_DETAIL_ROW_KEYS) assert(k in body.jobs[0], `row ${k}`);
  for (const k of FULL_DETAIL_SUMMARY_KEYS) {
    assert(k in body.summary, `summary ${k}`);
  }
});

Deno.test("access: the default detail is basic", () => {
  const body: any = buildJobProfitability(JOBS, PROFITS);
  assertEquals(body.summary.detail, "basic");
  assert(!("expected_cost_ex" in body.jobs[0]));
});

Deno.test("committed: null and incomplete while any order is unpriced or emailed without a bill", () => {
  const body: any = full(
    [job("c1"), job("c2"), job("c3")],
    [
      profit("c1", { committed_open_ex: 0, ordered_not_billed_count: 2 }),
      profit("c2", { committed_open_ex: 500, invoice_emailed_count: 1 }),
      profit("c3", { committed_open_ex: 750 }),
    ],
  );
  assertEquals(rowOf(body, "c1").committed_open_ex, null);
  assertEquals(rowOf(body, "c1").committed_complete, false);
  assertEquals(rowOf(body, "c2").committed_open_ex, null);
  assertEquals(rowOf(body, "c2").committed_complete, false);
  assertEquals(rowOf(body, "c3").committed_open_ex, 750);
  assertEquals(rowOf(body, "c3").committed_complete, true);
  const missing: any = full([job("c9")], []);
  assertEquals(missing.jobs[0].committed_open_ex, null);
  assertEquals(missing.jobs[0].committed_complete, false);
});

Deno.test("known: margin_ok with a null profit or margin is Unknown, never published", () => {
  const body: any = full(
    [job("k1"), job("k2")],
    [
      profit("k1", {
        invoiced_ex: 1000,
        margin_ok: true,
        profit_ex: null,
        margin_pct: 10,
      }),
      profit("k2", {
        invoiced_ex: 1000,
        margin_ok: true,
        profit_ex: 100,
        margin_pct: null,
      }),
    ],
  );
  for (const id of ["k1", "k2"]) {
    const r = rowOf(body, id);
    assertEquals(r.margin_status, "unknown");
    assertEquals(r.margin, null);
    assertEquals(r.margin_pct, null);
    assertEquals(r.margin_reason_codes, ["engine_reason_not_given"]);
    assertEquals(
      r.margin_reason,
      "Unknown: the Job Profit engine published no margin and gave no reason",
    );
  }
  assertEquals(body.summary.jobs_margin_known, 0);
  assertEquals(body.summary.avg_margin_pct, null);
  assertEquals(body.summary.unknown_reasons, { engine_reason_not_given: 2 });
});

Deno.test("unknown with no code and no flag: engine_reason_not_given", () => {
  const body: any = full([job("u1")], [
    profit("u1", {
      margin_ok: false,
      completeness: [],
      revenue_flag: "ok",
      cost_flag: "ok",
    }),
  ]);
  assertEquals(body.jobs[0].margin_reason_codes, ["engine_reason_not_given"]);
});

Deno.test("duplicate engine rows for one job fail loudly", () => {
  assertThrows(
    () => full([job("1")], [KNOWN, KNOWN]),
    Error,
    "more than one row for a job",
  );
});

Deno.test("limit: clamped to 1..5000, default 50", () => {
  assertEquals(jobProfitabilityLimit(null), 50);
  assertEquals(jobProfitabilityLimit(""), 50);
  assertEquals(jobProfitabilityLimit("abc"), 50);
  assertEquals(jobProfitabilityLimit("0"), 50);
  assertEquals(jobProfitabilityLimit("-20"), 1);
  assertEquals(jobProfitabilityLimit("120"), 120);
  assertEquals(jobProfitabilityLimit("999999"), 5000);
});

Deno.test("route: v_job_profit chunks run with bounded parallelism, results in job order", async () => {
  const many = Array.from(
    { length: PROFIT_READ_CHUNK * 7 + 3 },
    (_, i) => job(`p${i}`),
  );
  let inFlight = 0;
  let peak = 0;
  const sb = stubClient({
    jobs: () => ({ data: many, error: null }),
    v_job_profit: async (call) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const ids = call.ops.find(([op]) => op === "in")![1][1] as string[];
      return { data: ids.map((id) => profit(id)), error: null };
    },
  });
  const body: any = await jobProfitabilityAction(
    sb,
    new URLSearchParams({ limit: "5000" }),
    ORG,
    "full",
  );
  assertEquals(sb.calls.filter((c) => c.table === "v_job_profit").length, 8);
  assertEquals(peak, PROFIT_READ_CONCURRENCY);
  assertEquals(body.jobs.map((r: any) => r.id), many.map((j) => j.id));
});

Deno.test("route: the jobs read clamps limit", async () => {
  const sb = stubClient({
    jobs: () => ({ data: [], error: null }),
    v_job_profit: () => ({ data: [], error: null }),
  });
  await jobProfitabilityAction(sb, new URLSearchParams({ limit: "-3" }), ORG);
  assert(
    sb.calls[0].ops.some(([op, args]) => op === "limit" && args[0] === 1),
  );
});
