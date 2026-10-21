// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildJobProfitTimeline,
  costEventKind,
  JOB_PROFIT_LABELS,
  jobProfitAction,
  jobProfitCallerAllowed,
  jobProfitListAction,
  parseJobProfitListFilters,
} from "./job_profit.ts";

// A recording PostgREST stand-in: each from() answers from `tables` and logs
// the filters it was given.
function fakeClient(
  tables: Record<string, any[]>,
  errors: Record<string, string> = {},
) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const client = {
    calls,
    from(table: string) {
      const call = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      let window: [number, number] | null = null;
      const builder: any = {};
      for (const op of ["select", "order", "limit", "gte", "lte"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      // inclusive at both ends, as PostgREST reads a range
      builder.range = (from: number, to: number) => {
        call.ops.push(["range", [from, to]]);
        window = [from, to];
        return builder;
      };
      builder.eq = (col: string, val: unknown) => {
        call.ops.push(["eq", [col, val]]);
        rows = rows.filter((r) => r[col] === val);
        return builder;
      };
      builder.in = (col: string, vals: unknown[]) => {
        call.ops.push(["in", [col, vals]]);
        rows = rows.filter((r) => vals.includes(r[col]));
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          errors[table]
            ? { data: null, error: { message: errors[table] }, count: null }
            : {
              data: window ? rows.slice(window[0], window[1] + 1) : rows,
              error: null,
            },
        );
      return builder;
    },
  };
  return client;
}

const JOB = "a7000000-0000-4000-8000-000000000001";

Deno.test("only the ops key or an admin/owner session may read job profit", () => {
  assert(jobProfitCallerAllowed("api_key", null));
  assert(jobProfitCallerAllowed("jwt", "admin"));
  assert(jobProfitCallerAllowed("jwt", "Owner"));
  for (const role of ["ops_manager", "lead_installer", "trade", "", null]) {
    assert(
      !jobProfitCallerAllowed("jwt", role),
      `role ${role} must be refused`,
    );
  }
  assert(!jobProfitCallerAllowed("routine", "admin"));
  assert(!jobProfitCallerAllowed("agent_read", null));
  assert(!jobProfitCallerAllowed("none", null));
});

Deno.test("list filters are validated, never passed through raw", () => {
  const ok = parseJobProfitListFilters(
    new URLSearchParams(
      "type=fencing,patio&status=complete&from=2025-07-01&to=2026-06-30&date_field=invoiced&limit=50&offset=10",
    ),
  );
  assertEquals(ok, {
    ok: true,
    types: ["fencing", "patio"],
    statuses: ["complete"],
    from: "2025-07-01",
    to: "2026-06-30",
    dateField: "invoiced",
    limit: 50,
    offset: 10,
  });
  assertEquals(parseJobProfitListFilters(new URLSearchParams("")), {
    ok: true,
    types: [],
    statuses: [],
    from: null,
    to: null,
    dateField: "created",
    limit: 100,
    offset: 0,
  });
  assertEquals(
    parseJobProfitListFilters(new URLSearchParams("limit=500")).ok,
    true,
  );
  for (
    const bad of [
      "type=fencing)",
      "status=a;b",
      "from=1/7/2025",
      "to=2026-6-1",
      "date_field=paid",
      "limit=0",
      "limit=501",
      "offset=-1",
      "limit=abc",
    ]
  ) {
    assertEquals(
      parseJobProfitListFilters(new URLSearchParams(bad)).ok,
      false,
      bad,
    );
  }
});

Deno.test("timeline: every event in date order, one paid entry per paid document", () => {
  const costs = [
    {
      source: "trade_line",
      source_id: "l2",
      document_id: "ti1",
      document_number: "SW-INV-1",
      event_date: "2026-08-05",
      lane: "labour",
      party: "Trade One",
      amount_ex: "120.50",
      is_actual: true,
      paid: true,
      paid_on: "2026-08-20",
      confidence: "high",
    },
    {
      source: "trade_line",
      source_id: "l1",
      document_id: "ti1",
      document_number: "SW-INV-1",
      event_date: "2026-08-04",
      lane: "commission",
      party: "Trade One",
      amount_ex: 100,
      is_actual: true,
      paid: true,
      paid_on: "2026-08-20",
      confidence: "high",
    },
    {
      source: "po_committed",
      source_id: "po1",
      document_id: "po1",
      event_date: "2026-08-01",
      lane: "materials",
      party: "Supplier",
      amount_ex: 80,
      is_actual: false,
      paid: false,
      paid_on: null,
    },
  ];
  const revenue = [
    {
      kind: "invoice_line",
      source_id: "inv1:1",
      document_id: "inv1",
      document_number: "INV-1",
      invoice_date: "2026-08-08",
      amount_ex: 600,
      status: "PAID",
      paid: true,
      paid_on: "2026-08-18",
      counts_as_invoiced: true,
    },
    {
      kind: "invoice_line",
      source_id: "inv1:2",
      document_id: "inv1",
      document_number: "INV-1",
      invoice_date: "2026-08-08",
      amount_ex: 400,
      status: "PAID",
      paid: true,
      paid_on: "2026-08-18",
      counts_as_invoiced: true,
    },
    {
      kind: "variation",
      source_id: "v1",
      document_id: "v1",
      document_number: "V1",
      invoice_date: "2026-08-07",
      amount_ex: 100,
      status: "approved",
      paid: false,
      paid_on: null,
      counts_as_invoiced: false,
    },
  ];
  const t = buildJobProfitTimeline(costs, revenue);
  assertEquals(t.map((e) => [e.date, e.kind]), [
    ["2026-08-01", "purchase_order"],
    ["2026-08-04", "trade_charge"],
    ["2026-08-05", "trade_charge"],
    ["2026-08-07", "variation"],
    ["2026-08-08", "sales_invoice"],
    ["2026-08-08", "sales_invoice"],
    ["2026-08-18", "sales_invoice_paid"],
    ["2026-08-20", "cost_paid"],
  ]);
  const po = t.find((e) => e.kind === "purchase_order")!;
  assertEquals(po.counts, false, "a committed PO never counts as actual cost");
  assertEquals(
    t.find((e) => e.kind === "variation")!.counts,
    false,
    "a variation is listed, not invoiced",
  );
  assertEquals(t.find((e) => e.kind === "sales_invoice_paid")!.amount_ex, 1000);
  assertEquals(t.find((e) => e.kind === "cost_paid")!.amount_ex, 220.5);
  assertEquals(
    t.find((e) => e.kind === "trade_charge" && e.source_id === "l2")!.amount_ex,
    120.5,
  );
});

Deno.test("job_profit: needs a job, rejects malformed ids, 404 when absent", async () => {
  const c = fakeClient({ v_job_profit: [], jobs: [] });
  assertEquals((await jobProfitAction(c, new URLSearchParams(""))).status, 400);
  assertEquals(
    (await jobProfitAction(c, new URLSearchParams("job_id=nope"))).status,
    400,
  );
  assertEquals(
    (await jobProfitAction(c, new URLSearchParams("job_number=SWF-1;drop")))
      .status,
    400,
  );
  assertEquals(
    (await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`))).status,
    404,
  );
  assertEquals(
    (await jobProfitAction(c, new URLSearchParams("job_number=SWF-404")))
      .status,
    404,
  );
});

Deno.test("job_profit: summary from the engine, trades rolled up, timeline built", async () => {
  const c = fakeClient({
    jobs: [{ id: JOB, job_number: "SWF-1" }],
    v_job_profit: [{
      job_id: JOB,
      job_number: "SWF-1",
      invoiced_ex: 1000,
      actual_cost_ex: 570,
      profit_ex: 430,
    }],
    v_job_cost_events: [
      {
        job_id: JOB,
        source: "trade_line",
        source_id: "l1",
        document_id: "ti1",
        event_date: "2026-08-04",
        lane: "labour",
        party_id: "u1",
        party: "Trade One",
        amount_ex: 300,
        is_actual: true,
        paid: true,
        paid_on: "2026-08-20",
      },
      {
        job_id: JOB,
        source: "trade_line",
        source_id: "l2",
        document_id: "ti2",
        event_date: "2026-08-11",
        lane: "labour",
        party_id: "u1",
        party: "Trade One",
        amount_ex: 50,
        is_actual: true,
        paid: false,
        paid_on: null,
      },
      {
        job_id: JOB,
        source: "trade_line",
        source_id: "l3",
        document_id: "ti3",
        event_date: "2026-08-12",
        lane: "labour",
        party_id: "u2",
        party: "Trade One",
        amount_ex: 40,
        is_actual: true,
        paid: false,
        paid_on: null,
      },
      {
        job_id: JOB,
        source: "supplier_bill",
        source_id: "b1:1",
        document_id: "b1",
        event_date: "2026-08-02",
        lane: "materials",
        party: "Supplier",
        amount_ex: 100,
        is_actual: true,
        paid: true,
        paid_on: "2026-08-15",
      },
    ],
    v_job_revenue_events: [
      {
        job_id: JOB,
        kind: "invoice_line",
        source_id: "i1:1",
        document_id: "i1",
        invoice_date: "2026-08-08",
        amount_ex: 1000,
        status: "PAID",
        paid: true,
        paid_on: "2026-08-18",
        counts_as_invoiced: true,
      },
    ],
  });
  const out = await jobProfitAction(c, new URLSearchParams("job_number=swf-1"));
  assertEquals(out.status, 200);
  const body = out.body as any;
  assertEquals(
    body.job.profit_ex,
    430,
    "money comes from the engine row untouched",
  );
  assertEquals(body.trades, [
    {
      party_id: "u1",
      party: "Trade One",
      amount_ex: 350,
      lines: 2,
      first: "2026-08-04",
      last: "2026-08-11",
    },
    {
      party_id: "u2",
      party: "Trade One",
      amount_ex: 40,
      lines: 1,
      first: "2026-08-12",
      last: "2026-08-12",
    },
  ], "two trades with one name stay two rows");
  assertEquals(body.timeline.length, 4 + 1 + 3);
  assert(
    typeof body.labels.profit === "string" &&
      body.labels.profit.includes("No overhead"),
  );
  // the job number is upper-cased and every events read is scoped to the job id
  assertEquals(c.calls[0].table, "jobs");
  assertEquals(c.calls[0].ops.find(([op]) => op === "eq")![1], [
    "job_number",
    "SWF-1",
  ]);
  for (const call of c.calls.slice(1)) {
    assertEquals(call.ops.find(([op]) => op === "eq")![1], ["job_id", JOB]);
  }
});

Deno.test("job_profit: a read error is a 500, never an empty job", async () => {
  const c = fakeClient({ v_job_profit: [{ job_id: JOB }] }, {
    v_job_cost_events: "column x does not exist",
  });
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 500);
  const c2 = fakeClient({}, { v_job_profit: "permission denied" });
  assertEquals(
    (await jobProfitAction(c2, new URLSearchParams(`job_id=${JOB}`))).status,
    500,
  );
});

Deno.test("job_profit: a job number on two jobs asks for the id", async () => {
  const c = fakeClient({
    jobs: [{ id: "x", job_number: "SWF-2" }, { id: "y", job_number: "SWF-2" }],
  });
  const out = await jobProfitAction(c, new URLSearchParams("job_number=SWF-2"));
  assertEquals(out.status, 409);
  assertEquals(
    c.calls.length,
    1,
    "ambiguous job numbers stop before reading the engine",
  );
});

Deno.test("job_profit: job-number lookup errors are visible", async () => {
  const c = fakeClient({}, { jobs: "database unavailable" });
  const out = await jobProfitAction(c, new URLSearchParams("job_number=SWF-3"));
  assertEquals(out.status, 500);
  assert((out.body.error as string).includes("job number lookup failed"));
});

Deno.test("job_profit_list: filters reach the engine; bad filters are 400", async () => {
  const c = fakeClient({
    v_job_profit: [{ job_id: "a", work_type: "fencing", status: "complete" }, {
      job_id: "b",
      work_type: "makesafe",
      status: "complete",
    }],
  });
  const out = await jobProfitListAction(
    c,
    new URLSearchParams(
      "type=fencing&status=complete&from=2025-07-01&date_field=invoiced",
    ),
  );
  assertEquals(out.status, 200);
  assertEquals((out.body as any).jobs.map((j: any) => j.job_id), ["a"]);
  const ops = c.calls[0].ops;
  assert(
    ops.some(([op, args]) =>
      op === "gte" && args[0] === "first_invoice_date" &&
      args[1] === "2025-07-01"
    ),
  );
  assertEquals((out.body as any).has_more, false);
  const perth = fakeClient({ v_job_profit: [] });
  await jobProfitListAction(
    perth,
    new URLSearchParams("from=2025-07-01&to=2026-06-30"),
  );
  const perthOps = perth.calls[0].ops;
  assert(
    perthOps.some(([op, args]) =>
      op === "gte" && args[0] === "created_at" &&
      args[1] === "2025-07-01T00:00:00+08:00"
    ),
  );
  assert(
    perthOps.some(([op, args]) =>
      op === "lte" && args[0] === "created_at" &&
      args[1] === "2026-06-30T23:59:59.999+08:00"
    ),
  );
  assertEquals(
    (await jobProfitListAction(c, new URLSearchParams("limit=99999"))).status,
    400,
  );
  const bad = fakeClient({}, { v_job_profit: "boom" });
  assertEquals(
    (await jobProfitListAction(bad, new URLSearchParams(""))).status,
    500,
  );
});

Deno.test("job_profit_list: pages past the first, and says when another follows", async () => {
  const jobs = ["a", "b", "c", "d", "e"].map((job_id) => ({
    job_id,
    work_type: "fencing",
  }));
  const page = async (query: string) => {
    const out = await jobProfitListAction(
      fakeClient({
        v_job_profit: [...jobs, { job_id: "m", work_type: "makesafe" }],
      }),
      new URLSearchParams(`type=fencing&${query}`),
    );
    assertEquals(out.status, 200);
    const body = out.body as any;
    return [body.jobs.map((j: any) => j.job_id), body.has_more];
  };
  assertEquals(await page("limit=2"), [["a", "b"], true]);
  assertEquals(await page("limit=2&offset=2"), [["c", "d"], true]);
  assertEquals(await page("limit=2&offset=4"), [["e"], false]);
  assertEquals(await page("limit=5"), [["a", "b", "c", "d", "e"], false]);
  assertEquals(
    await page("limit=2&offset=50"),
    [[], false],
    "an offset past the last job is an empty page, never an error",
  );
});

Deno.test("rollup: expected and quoted count only jobs the engine gave a quote figure", async () => {
  const row = (over: Record<string, unknown>) => ({
    work_type: "fencing",
    status: "complete",
    created_at: "2026-08-01T00:00:00Z",
    first_invoice_date: null,
    invoiced_ex: 0,
    collected_ex: 0,
    quoted_ex: null,
    expected_cost_ex: null,
    actual_cost_ex: 0,
    profit_ex: null,
    xero_project_expenses_ex: null,
    revenue_verified_paid: false,
    ...over,
  });
  const c = fakeClient({
    v_job_profit: [
      row({
        job_id: "won",
        invoiced_ex: 1500,
        quoted_ex: 1400,
        expected_cost_ex: 1000,
        actual_cost_ex: 900,
      }),
      row({
        job_id: "sent",
        status: "quoted",
        quoted_ex: 600,
        expected_cost_ex: 400,
      }),
      row({ job_id: "lead", status: "draft", actual_cost_ex: 50 }),
    ],
  });
  const out = await jobProfitListAction(c, new URLSearchParams("view=rollup"));
  assertEquals(out.status, 200);
  const totals = (out.body as any).totals;
  assertEquals(totals.jobs, 3);
  assertEquals(totals.jobs_with_quote, 2);
  assertEquals(totals.quoted_ex, 2000);
  assertEquals(totals.invoiced_on_quoted_ex, 1500);
  assertEquals(totals.jobs_with_expected, 2);
  assertEquals(totals.expected_cost_ex, 1400);
  assertEquals(totals.actual_cost_on_expected_ex, 900);
  assertEquals(totals.actual_cost_ex, 950);

  const leadsOnly = fakeClient({
    v_job_profit: [row({ job_id: "lead", status: "draft" })],
  });
  const none = (await jobProfitListAction(
    leadsOnly,
    new URLSearchParams("view=rollup&status=draft"),
  )).body as any;
  assertEquals(none.totals.jobs_with_quote, 0);
  assertEquals(none.totals.quoted_ex, null);
  assertEquals(none.totals.invoiced_on_quoted_ex, null);
  assertEquals(none.totals.jobs_with_expected, 0);
  assertEquals(none.totals.expected_cost_ex, null);
  assertEquals(none.totals.actual_cost_on_expected_ex, null);
});

Deno.test("rollup: Xero Project expenses are in no total of cost or profit", async () => {
  const base = {
    work_type: "makesafe",
    status: "complete",
    created_at: "2026-08-01T00:00:00Z",
    first_invoice_date: "2026-08-08",
    collected_ex: 0,
    quoted_ex: null,
    expected_cost_ex: null,
    revenue_verified_paid: false,
  };
  const c = fakeClient({
    v_job_profit: [
      // project expenses 5000 on record, trade labour 3000 not on the project
      {
        ...base,
        job_id: "project",
        invoiced_ex: 10000,
        actual_cost_ex: 3000,
        xero_project_expenses_ex: 5000,
        profit_ex: null,
      },
      {
        ...base,
        job_id: "plain",
        invoiced_ex: 1000,
        actual_cost_ex: 600,
        xero_project_expenses_ex: null,
        profit_ex: 400,
      },
    ],
  });
  const body = (await jobProfitListAction(
    c,
    new URLSearchParams("view=rollup&date_field=invoiced"),
  )).body as any;
  for (const bucket of [body.totals, body.by_type[0], body.by_month[0]]) {
    assertEquals(bucket.jobs, 2);
    assertEquals(bucket.actual_cost_ex, 3600);
    assertEquals(bucket.jobs_with_margin, 1);
    assertEquals(bucket.profit_ex, 400);
    assertEquals(bucket.published_revenue_ex, 1000);
    assertEquals(bucket.published_cost_ex, 600);
    assertEquals(bucket.margin_pct, 40);
  }
});

Deno.test("rollup: a published Xero Project margin counts the project figure once", async () => {
  const base = {
    work_type: "fencing",
    status: "complete",
    created_at: "2026-08-01T00:00:00Z",
    first_invoice_date: "2026-08-08",
    collected_ex: 0,
    quoted_ex: null,
    expected_cost_ex: null,
    revenue_verified_paid: false,
  };
  const c = fakeClient({
    v_job_profit: [
      {
        ...base,
        job_id: "project",
        invoiced_ex: 10000,
        actual_cost_ex: 3000,
        margin_cost_ex: 5000,
        profit_ex: 5000,
      },
      {
        ...base,
        job_id: "plain",
        invoiced_ex: 1000,
        actual_cost_ex: 600,
        profit_ex: 400,
      },
    ],
  });
  const body = (await jobProfitListAction(
    c,
    new URLSearchParams("view=rollup"),
  )).body as any;
  assertEquals(body.totals.jobs_with_margin, 2);
  assertEquals(body.totals.actual_cost_ex, 3600);
  assertEquals(body.totals.published_cost_ex, 5600);
  assertEquals(body.totals.published_revenue_ex, 11000);
  assertEquals(body.totals.profit_ex, 5400);
});

// CFO-12: the three purchase order states reach the timeline as orders, never
// as a bill, never as actual cost, and an unpriced order carries no $0.00.
Deno.test("job profit timeline: ordered, invoice-emailed and committed orders (CFO-12)", () => {
  const costs = [
    {
      source: "po_committed",
      source_id: "po1",
      document_id: "po1",
      event_date: "2026-08-01",
      lane: "materials",
      party: "Supplier",
      amount_ex: 200,
      is_actual: false,
      paid: false,
      paid_on: null,
      confidence: "committed",
    },
    {
      source: "po_ordered",
      source_id: "po2",
      document_id: "po2",
      document_number: "PO-1000001",
      event_date: "2026-08-02",
      lane: "materials",
      party: "Dispatch Supplier",
      amount_ex: null,
      is_actual: false,
      paid: false,
      paid_on: null,
      confidence: "ordered_not_billed",
    },
    {
      source: "po_invoice_emailed",
      source_id: "po3",
      document_id: "po3",
      event_date: "2026-09-02",
      lane: "materials",
      party: "Supplier",
      amount_ex: 300,
      is_actual: false,
      paid: false,
      paid_on: null,
      confidence: "invoice_emailed",
    },
  ];
  const t = buildJobProfitTimeline(costs, []);
  assertEquals(t.map((e) => [e.date, e.kind, e.amount_ex, e.counts]), [
    ["2026-08-01", "purchase_order", 200, false],
    ["2026-08-02", "purchase_order_ordered", null, false],
    ["2026-09-02", "purchase_order_invoice_emailed", 300, false],
  ]);
  assert(!t.some((e) => e.kind === "cost_paid"), "no order is ever a paid cost");
  assert(
    !t.some((e) => e.kind === "supplier_bill"),
    "no order state is shown as a supplier bill",
  );
});

Deno.test("costEventKind: an unknown po_ state is a purchase order, other unknowns stay supplier bills", () => {
  assertEquals(costEventKind("po_committed"), "purchase_order");
  assertEquals(costEventKind("po_ordered"), "purchase_order_ordered");
  assertEquals(costEventKind("po_invoice_emailed"), "purchase_order_invoice_emailed");
  assertEquals(costEventKind("po_something_new"), "purchase_order");
  assertEquals(costEventKind("supplier_bill"), "supplier_bill");
  assertEquals(costEventKind("materials_fact"), "materials_fact");
  assertEquals(costEventKind(undefined), "supplier_bill");
});

Deno.test("job profit labels name the CFO-12 commitment states", () => {
  assert(JOB_PROFIT_LABELS.committed_open_ex.includes("never counted here as $0.00"));
  assert(JOB_PROFIT_LABELS.ordered_not_billed_count.startsWith("Ordered, not billed"));
  assert(JOB_PROFIT_LABELS.invoice_emailed_count.startsWith("Invoice emailed, no bill matched to this order"));
  assert(JOB_PROFIT_LABELS.invoice_emailed_count.includes("never nothing owed"));
  assert(JOB_PROFIT_LABELS.margin_source.includes("from Xero Project, may exclude unlinked labour"));
  assert(JOB_PROFIT_LABELS.work_order_agreed_labour_ex.includes("A draft is not included"));
  assert(JOB_PROFIT_LABELS.expected_cost_ex.includes("approved job work order"));
  assert(JOB_PROFIT_LABELS.xero_project_exceeds_line_costs.includes("this suppressor is not set"));
});
