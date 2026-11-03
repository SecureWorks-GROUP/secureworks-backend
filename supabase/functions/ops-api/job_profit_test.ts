// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { costEventKind, JOB_PROFIT_LABELS, jobProfitAction, jobProfitCallerAllowed, jobProfitListAction } from "./job_profit.ts";

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

Deno.test("only the ops key or an admin, owner or office-staff session may read job profit", () => {
  assert(jobProfitCallerAllowed("api_key", null));
  assert(jobProfitCallerAllowed("jwt", "admin"));
  assert(jobProfitCallerAllowed("jwt", "Owner"));
  assert(jobProfitCallerAllowed("jwt", "ops_manager"));
  for (const role of ["lead_installer", "trade", "crew", "estimator", "", null]) {
    assert(
      !jobProfitCallerAllowed("jwt", role),
      `role ${role} must be refused`,
    );
  }
  assert(!jobProfitCallerAllowed("routine", "admin"));
  assert(!jobProfitCallerAllowed("agent_read", null));
  assert(!jobProfitCallerAllowed("none", null));
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
    assertEquals(
      call.ops.find(([op]) => op === "eq")![1],
      call.table === "jobs" ? ["id", JOB] : ["job_id", JOB],
    );
  }
  // a job that is not a patio scoper record gets no patio_expected key
  assertEquals("patio_expected" in body, false);
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
        cost_flag: "ok",
      }),
      row({
        job_id: "sent",
        status: "quoted",
        quoted_ex: 600,
        expected_cost_ex: 400,
        cost_flag: "text_matched_lines",
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

Deno.test("rollup: expected vs actual counts only jobs whose actual cost is complete", async () => {
  const row = (over: Record<string, unknown>) => ({
    work_type: "fencing",
    status: "complete",
    created_at: "2026-08-01T00:00:00Z",
    first_invoice_date: null,
    invoiced_ex: 5000,
    collected_ex: 0,
    quoted_ex: 5000,
    actual_cost_ex: 0,
    profit_ex: null,
    revenue_verified_paid: false,
    holding_job: false,
    ...over,
  });
  const body = (await jobProfitListAction(
    fakeClient({
      v_job_profit: [
        // labour only so far: 3000 expected (labour, materials, commission)
        // against 900 of labour must not read as 2100 under expected
        row({
          job_id: "labour-only",
          expected_cost_ex: 3000,
          actual_cost_ex: 900,
          cost_flag: "materials_not_linked",
        }),
        row({
          job_id: "nothing",
          expected_cost_ex: 2000,
          cost_flag: "no_cost_linked",
        }),
        row({
          job_id: "complete",
          expected_cost_ex: 2500,
          actual_cost_ex: 2700,
          cost_flag: "ok",
          profit_ex: 2300,
        }),
      ],
    }),
    new URLSearchParams("view=rollup"),
  )).body as any;
  for (const bucket of [body.totals, body.by_type[0], body.by_month[0]]) {
    assertEquals(bucket.jobs, 3);
    assertEquals(bucket.jobs_with_expected, 1);
    assertEquals(bucket.expected_cost_ex, 2500);
    assertEquals(bucket.actual_cost_on_expected_ex, 2700);
    assertEquals(bucket.jobs_with_expected_not_comparable, 2);
    assertEquals(bucket.expected_cost_not_comparable_ex, 5000);
    assertEquals(bucket.actual_cost_ex, 3600);
  }

  const partialOnly = (await jobProfitListAction(
    fakeClient({
      v_job_profit: [row({
        job_id: "labour-only",
        expected_cost_ex: 3000,
        actual_cost_ex: 900,
        cost_flag: "materials_not_linked",
      })],
    }),
    new URLSearchParams("view=rollup"),
  )).body as any;
  assertEquals(partialOnly.totals.jobs_with_expected, 0);
  assertEquals(partialOnly.totals.expected_cost_ex, null);
  assertEquals(partialOnly.totals.actual_cost_on_expected_ex, null);
});

Deno.test("rollup: an expected cost with a lane unknown is never compared (TP-13)", async () => {
  const row = (over: Record<string, unknown>) => ({
    work_type: "fencing",
    status: "complete",
    created_at: "2026-08-01T00:00:00Z",
    first_invoice_date: null,
    invoiced_ex: 5000,
    collected_ex: 0,
    quoted_ex: 5000,
    actual_cost_ex: 2700,
    profit_ex: 2300,
    revenue_verified_paid: false,
    holding_job: false,
    cost_flag: "ok",
    completeness: [],
    ...over,
  });
  const body = (await jobProfitListAction(
    fakeClient({
      v_job_profit: [
        // commission lane unknown at the quote: 1200 is labour plus materials only
        row({
          job_id: "lane-missing",
          expected_cost_ex: 1200,
          completeness: ["expected_cost_lane_missing"],
        }),
        row({ job_id: "whole", expected_cost_ex: 2500 }),
      ],
    }),
    new URLSearchParams("view=rollup"),
  )).body as any;
  assertEquals(body.totals.jobs_with_expected, 1);
  assertEquals(body.totals.expected_cost_ex, 2500);
  assertEquals(body.totals.actual_cost_on_expected_ex, 2700);
  assertEquals(body.totals.jobs_with_expected_not_comparable, 1);
  assertEquals(body.totals.expected_cost_not_comparable_ex, 1200);
  // the margin is the engine's: both jobs published one
  assertEquals(body.totals.jobs_with_margin, 2);
});

Deno.test("rollup: a group with no publishable job reads profit and margin as Unknown, not 0", async () => {
  const row = (over: Record<string, unknown>) => ({
    status: "complete",
    created_at: "2026-08-01T00:00:00Z",
    first_invoice_date: null,
    collected_ex: 0,
    quoted_ex: null,
    expected_cost_ex: null,
    revenue_verified_paid: false,
    holding_job: false,
    ...over,
  });
  const body = (await jobProfitListAction(
    fakeClient({
      v_job_profit: [
        row({
          job_id: "fence",
          work_type: "fencing",
          invoiced_ex: 9000,
          actual_cost_ex: 2000,
          profit_ex: null,
          cost_flag: "materials_not_linked",
        }),
        row({
          job_id: "ms",
          work_type: "makesafe",
          invoiced_ex: 500,
          actual_cost_ex: 200,
          profit_ex: 300,
          cost_flag: "ok",
        }),
      ],
    }),
    new URLSearchParams("view=rollup"),
  )).body as any;
  const fencing = body.by_type.find((r: any) => r.work_type === "fencing");
  assertEquals(fencing.jobs_with_margin, 0);
  assertEquals(fencing.profit_ex, null);
  assertEquals(fencing.margin_pct, null);
  assertEquals(fencing.published_revenue_ex, null);
  assertEquals(fencing.published_cost_ex, null);
  assertEquals(fencing.actual_cost_ex, 2000);
  const makesafe = body.by_type.find((r: any) => r.work_type === "makesafe");
  assertEquals(makesafe.profit_ex, 300);
  assertEquals(makesafe.margin_pct, 60);
  assertEquals(body.totals.profit_ex, 300);
  assertEquals(body.totals.published_revenue_ex, 500);
});

Deno.test("rollup: a holding job is in no total, type or month, and is reported on its own", async () => {
  const row = (over: Record<string, unknown>) => ({
    work_type: "fencing",
    status: "archived",
    created_at: "2026-08-01T00:00:00Z",
    first_invoice_date: null,
    collected_ex: 0,
    quoted_ex: null,
    expected_cost_ex: null,
    profit_ex: null,
    revenue_verified_paid: false,
    cost_flag: "materials_not_linked",
    ...over,
  });
  const body = (await jobProfitListAction(
    fakeClient({
      v_job_profit: [
        row({
          job_id: "bucket",
          invoiced_ex: 0,
          actual_cost_ex: 192604.7,
          holding_job: true,
          cost_flag: "no_labour_linked",
        }),
        row({
          job_id: "real",
          invoiced_ex: 8000,
          actual_cost_ex: 1500,
          holding_job: false,
        }),
      ],
    }),
    new URLSearchParams("view=rollup"),
  )).body as any;
  for (const bucket of [body.totals, body.by_type[0], body.by_month[0]]) {
    assertEquals(bucket.jobs, 1);
    assertEquals(bucket.actual_cost_ex, 1500);
    assertEquals(bucket.invoiced_ex, 8000);
  }
  assertEquals(body.by_type.length, 1);
  assertEquals(body.by_month.length, 1);
  assertEquals(body.holding_jobs.jobs, 1);
  assertEquals(body.holding_jobs.actual_cost_ex, 192604.7);
  assertEquals(body.holding_jobs.profit_ex, null);
});

Deno.test("a Xero crew bill's company super is employer super on the timeline, never a supplier bill", () => {
  assertEquals(costEventKind("bill_employer_super"), "employer_super");
  assertEquals(costEventKind("trade_employer_super"), "employer_super");
  assertEquals(costEventKind("supplier_bill"), "supplier_bill");
});

Deno.test("employer super remains a separate unpaid obligation, not a supplier bill or trade cash", async () => {
  const events = [
    {
      job_id: JOB,
      source: "trade_line",
      source_id: "share",
      document_id: "bill",
      party_id: "crew",
      party: "Test crew",
      lane: "labour",
      amount_ex: 2428.57,
      event_date: null,
      is_actual: true,
      paid: true,
      paid_on: "2026-10-30",
    },
    {
      job_id: JOB,
      source: "trade_employer_super",
      source_id: "share:employer_super",
      document_id: "bill",
      party_id: "crew",
      party: "Test crew",
      lane: "labour",
      amount_ex: 291.43,
      event_date: null,
      is_actual: true,
      paid: false,
      paid_on: null,
    },
    {
      job_id: JOB,
      source: "trade_line",
      source_id: "advance",
      document_id: "advance-bill",
      party_id: "crew",
      party: "Test crew",
      lane: "advance",
      amount_ex: 2100,
      event_date: "2026-10-30",
      is_actual: false,
      paid: true,
      paid_on: "2026-10-30",
    },
    {
      job_id: JOB,
      source: "trade_employer_super",
      source_id: "advance:employer_super",
      document_id: "advance-bill",
      party_id: "crew",
      party: "Test crew",
      lane: "advance",
      amount_ex: 126,
      event_date: "2026-10-30",
      is_actual: false,
      paid: false,
      paid_on: null,
    },
  ];
  const summary = {
    job_id: JOB,
    actual_cost_ex: 2720,
    profit_ex: null,
    margin_pct: null,
    completeness: ["materials_not_linked"],
  };
  const out = await jobProfitAction(
    fakeClient({ v_job_profit: [summary], v_job_cost_events: events }),
    new URLSearchParams(`job_id=${JOB}`),
  );
  assertEquals(out.status, 200);
  assertEquals(
    out.body.job,
    summary,
    "engine totals and Unknown remain untouched",
  );
  const timeline = out.body.timeline as any[];
  assertEquals(
    timeline.filter((e) => e.source === "trade_employer_super").map(
      (e) => [e.kind, e.counts, e.paid, e.date],
    ),
    [
      ["employer_super", false, false, "2026-10-30"],
      ["employer_super", true, false, null],
    ],
  );
  assertEquals(
    timeline.filter((e) => e.kind === "cost_paid").map((e) => e.amount_ex),
    [2428.57],
    "cash payment does not settle super or count an advance as earned cost",
  );
  assertEquals(
    (out.body.trades as any[])[0].amount_ex,
    2428.57,
    "trade cash charges remain separate from employer obligation",
  );
  assertEquals(
    out.body.cost_events,
    events,
    "original identity and counting fields retained",
  );
  assert(!JOB_PROFIT_LABELS.profit.includes("super share is not added"));
});

Deno.test("job_profit: line evidence comes with the figures; a failed read is unknown, never verified", async () => {
  const tables = {
    jobs: [{ id: JOB, job_number: "SWF-1" }],
    v_job_profit: [{ job_id: JOB, job_number: "SWF-1", invoiced_ex: 1000, actual_cost_ex: 570, profit_ex: 430 }],
    v_job_cost_events: [],
    v_job_revenue_events: [],
  };
  const ok: any = fakeClient(tables);
  const seen: unknown[] = [];
  ok.rpc = (fn: string, args: unknown) => {
    seen.push([fn, args]);
    return Promise.resolve({ data: { status: "provisional", items: 3, evidenced: 1 }, error: null });
  };
  const r1 = await jobProfitAction(ok, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(r1.status, 200);
  assertEquals((r1.body as any).line_evidence, { status: "provisional", items: 3, evidenced: 1 });
  assertEquals(seen, [["job_profit_line_evidence", { p_job_id: JOB }]]);

  const bad: any = fakeClient(tables);
  bad.rpc = () => Promise.resolve({ data: null, error: { message: "timeout" } });
  const r2 = await jobProfitAction(bad, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(r2.status, 200, "figures still return when the evidence read fails");
  assertEquals((r2.body as any).line_evidence.status, "unknown");

  const none: any = fakeClient(tables);
  const r3 = await jobProfitAction(none, new URLSearchParams(`job_id=${JOB}`));
  assertEquals((r3.body as any).line_evidence.status, "unknown");
});
