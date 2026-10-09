import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildJobProfitTimeline,
  jobProfitAction,
  jobProfitCallerAllowed,
  jobProfitListAction,
  parseJobProfitListFilters,
} from "./job_profit.ts";

// A recording PostgREST stand-in: each from() answers from `tables` and logs
// the filters it was given.
function fakeClient(tables: Record<string, any[]>, errors: Record<string, string> = {}) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const client = {
    calls,
    from(table: string) {
      const call = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      const builder: any = {};
      for (const op of ["select", "order", "limit", "range", "gte", "lte"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
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
        resolve(errors[table] ? { data: null, error: { message: errors[table] }, count: null } : { data: rows, error: null, count: rows.length });
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
    assert(!jobProfitCallerAllowed("jwt", role), `role ${role} must be refused`);
  }
  assert(!jobProfitCallerAllowed("routine", "admin"));
  assert(!jobProfitCallerAllowed("agent_read", null));
  assert(!jobProfitCallerAllowed("none", null));
});

Deno.test("list filters are validated, never passed through raw", () => {
  const ok = parseJobProfitListFilters(new URLSearchParams("type=fencing,patio&status=complete&from=2025-07-01&to=2026-06-30&date_field=invoiced&limit=50&offset=10"));
  assertEquals(ok, { ok: true, types: ["fencing", "patio"], statuses: ["complete"], from: "2025-07-01", to: "2026-06-30", dateField: "invoiced", limit: 50, offset: 10 });
  assertEquals(parseJobProfitListFilters(new URLSearchParams("")).ok, true);
  for (const bad of ["type=fencing)", "status=a;b", "from=1/7/2025", "to=2026-6-1", "date_field=paid", "limit=0", "limit=5000", "offset=-1", "limit=abc"]) {
    assertEquals(parseJobProfitListFilters(new URLSearchParams(bad)).ok, false, bad);
  }
});

Deno.test("timeline: every event in date order, one paid entry per paid document", () => {
  const costs = [
    { source: "trade_line", source_id: "l2", document_id: "ti1", document_number: "SW-INV-1", event_date: "2026-08-05", lane: "labour", party: "Trade One", amount_ex: "120.50", is_actual: true, paid: true, paid_on: "2026-08-20", confidence: "high" },
    { source: "trade_line", source_id: "l1", document_id: "ti1", document_number: "SW-INV-1", event_date: "2026-08-04", lane: "commission", party: "Trade One", amount_ex: 100, is_actual: true, paid: true, paid_on: "2026-08-20", confidence: "high" },
    { source: "po_committed", source_id: "po1", document_id: "po1", event_date: "2026-08-01", lane: "materials", party: "Supplier", amount_ex: 80, is_actual: false, paid: false, paid_on: null },
  ];
  const revenue = [
    { kind: "invoice_line", source_id: "inv1:1", document_id: "inv1", document_number: "INV-1", invoice_date: "2026-08-08", amount_ex: 600, status: "PAID", paid: true, paid_on: "2026-08-18", counts_as_invoiced: true },
    { kind: "invoice_line", source_id: "inv1:2", document_id: "inv1", document_number: "INV-1", invoice_date: "2026-08-08", amount_ex: 400, status: "PAID", paid: true, paid_on: "2026-08-18", counts_as_invoiced: true },
    { kind: "variation", source_id: "v1", document_id: "v1", document_number: "V1", invoice_date: "2026-08-07", amount_ex: 100, status: "approved", paid: false, paid_on: null, counts_as_invoiced: false },
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
  assertEquals(t.find((e) => e.kind === "variation")!.counts, false, "a variation is listed, not invoiced");
  assertEquals(t.find((e) => e.kind === "sales_invoice_paid")!.amount_ex, 1000);
  assertEquals(t.find((e) => e.kind === "cost_paid")!.amount_ex, 220.5);
  assertEquals(t.find((e) => e.kind === "trade_charge" && e.source_id === "l2")!.amount_ex, 120.5);
});

Deno.test("job_profit: needs a job, rejects malformed ids, 404 when absent", async () => {
  const c = fakeClient({ v_job_profit: [] });
  assertEquals((await jobProfitAction(c, new URLSearchParams(""))).status, 400);
  assertEquals((await jobProfitAction(c, new URLSearchParams("job_id=nope"))).status, 400);
  assertEquals((await jobProfitAction(c, new URLSearchParams("job_number=SWF-1;drop"))).status, 400);
  assertEquals((await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`))).status, 404);
});

Deno.test("job_profit: summary from the engine, trades rolled up, timeline built", async () => {
  const c = fakeClient({
    v_job_profit: [{ job_id: JOB, job_number: "SWF-1", invoiced_ex: 1000, actual_cost_ex: 570, profit_ex: 430 }],
    v_job_cost_events: [
      { job_id: JOB, source: "trade_line", source_id: "l1", document_id: "ti1", event_date: "2026-08-04", lane: "labour", party: "Trade One", amount_ex: 300, is_actual: true, paid: true, paid_on: "2026-08-20" },
      { job_id: JOB, source: "trade_line", source_id: "l2", document_id: "ti2", event_date: "2026-08-11", lane: "labour", party: "Trade One", amount_ex: 50, is_actual: true, paid: false, paid_on: null },
      { job_id: JOB, source: "supplier_bill", source_id: "b1:1", document_id: "b1", event_date: "2026-08-02", lane: "materials", party: "Supplier", amount_ex: 100, is_actual: true, paid: true, paid_on: "2026-08-15" },
    ],
    v_job_revenue_events: [
      { job_id: JOB, kind: "invoice_line", source_id: "i1:1", document_id: "i1", invoice_date: "2026-08-08", amount_ex: 1000, status: "PAID", paid: true, paid_on: "2026-08-18", counts_as_invoiced: true },
    ],
  });
  const out = await jobProfitAction(c, new URLSearchParams("job_number=swf-1"));
  assertEquals(out.status, 200);
  const body = out.body as any;
  assertEquals(body.job.profit_ex, 430, "money comes from the engine row untouched");
  assertEquals(body.trades, [{ party: "Trade One", amount_ex: 350, lines: 2, first: "2026-08-04", last: "2026-08-11" }]);
  assertEquals(body.timeline.length, 3 + 1 + 3);
  assert(typeof body.labels.profit === "string" && body.labels.profit.includes("No overhead"));
  // the job number is upper-cased and every events read is scoped to the job id
  assertEquals(c.calls[0].ops.find(([op]) => op === "eq")![1], ["job_number", "SWF-1"]);
  for (const call of c.calls.slice(1)) assertEquals(call.ops.find(([op]) => op === "eq")![1], ["job_id", JOB]);
});

Deno.test("job_profit: a read error is a 500, never an empty job", async () => {
  const c = fakeClient({ v_job_profit: [{ job_id: JOB }] }, { v_job_cost_events: "column x does not exist" });
  const out = await jobProfitAction(c, new URLSearchParams(`job_id=${JOB}`));
  assertEquals(out.status, 500);
  const c2 = fakeClient({}, { v_job_profit: "permission denied" });
  assertEquals((await jobProfitAction(c2, new URLSearchParams(`job_id=${JOB}`))).status, 500);
});

Deno.test("job_profit: a job number on two jobs asks for the id", async () => {
  const c = fakeClient({ v_job_profit: [{ job_id: "x", job_number: "SWF-2" }, { job_id: "y", job_number: "SWF-2" }] });
  const out = await jobProfitAction(c, new URLSearchParams("job_number=SWF-2"));
  assertEquals(out.status, 409);
});

Deno.test("job_profit_list: filters reach the engine; bad filters are 400", async () => {
  const c = fakeClient({ v_job_profit: [{ job_id: "a", work_type: "fencing", status: "complete" }, { job_id: "b", work_type: "makesafe", status: "complete" }] });
  const out = await jobProfitListAction(c, new URLSearchParams("type=fencing&status=complete&from=2025-07-01&date_field=invoiced"));
  assertEquals(out.status, 200);
  assertEquals((out.body as any).jobs.map((j: any) => j.job_id), ["a"]);
  const ops = c.calls[0].ops;
  assert(ops.some(([op, args]) => op === "gte" && args[0] === "first_invoice_date" && args[1] === "2025-07-01"));
  assert(ops.some(([op, args]) => op === "range" && args[0] === 0 && args[1] === 199));
  assertEquals((await jobProfitListAction(c, new URLSearchParams("limit=99999"))).status, 400);
  const bad = fakeClient({}, { v_job_profit: "boom" });
  assertEquals((await jobProfitListAction(bad, new URLSearchParams(""))).status, 500);
});
